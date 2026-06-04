-- =====================================================================
-- Logistics Platform — Phase 7: Financial Reconciliation & Driver Wallets
-- Target: Supabase (PostgreSQL)
--
-- Money precision policy:
--   All monetary columns are numeric(10,2) — exact decimal, never float.
--   ALL arithmetic (merchant_share, wallet sums) is performed in SQL so it
--   stays exact. The API serializes amounts as strings to avoid any
--   floating-point drift in JavaScript/JSON.
-- Safe to re-run.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. TABLE: financial_transactions
-- ---------------------------------------------------------------------
create table if not exists public.financial_transactions (
  id               uuid primary key default gen_random_uuid(),
  shipment_id      uuid not null unique references public.shipments (id),
  driver_id        uuid not null references public.profiles (id),
  merchant_id      uuid not null references public.profiles (id),
  amount_collected numeric(10,2) not null,   -- total COD collected from customer
  delivery_fee     numeric(10,2) not null,   -- fee retained by the platform
  merchant_share   numeric(10,2) not null,   -- amount_collected - delivery_fee
  status           text not null default 'HELD_BY_DRIVER'
                     check (status in ('HELD_BY_DRIVER', 'SETTLED_WITH_COMPANY', 'PAID_TO_MERCHANT')),
  reconciled_by    uuid references public.profiles (id),  -- admin who cleared the cash
  created_at       timestamptz not null default now()
);

comment on table public.financial_transactions is
  'One COD financial record per delivered shipment. merchant_share is computed exactly in SQL.';

create index if not exists idx_fin_tx_driver_status   on public.financial_transactions (driver_id, status);
create index if not exists idx_fin_tx_merchant_status on public.financial_transactions (merchant_id, status);
create index if not exists idx_fin_tx_reconciled_by   on public.financial_transactions (reconciled_by);

-- ---------------------------------------------------------------------
-- 2. RLS — lock the table down (backend uses service_role, which bypasses)
-- ---------------------------------------------------------------------
alter table public.financial_transactions enable row level security;

drop policy if exists "fin_tx_driver_select"   on public.financial_transactions;
drop policy if exists "fin_tx_merchant_select"  on public.financial_transactions;
drop policy if exists "fin_tx_admin_all"        on public.financial_transactions;

-- Drivers may read only their own financial rows.
create policy "fin_tx_driver_select"
  on public.financial_transactions
  for select to authenticated
  using (public.get_user_role() = 'DRIVER' and driver_id = auth.uid());

-- Merchants may read only their own financial rows.
create policy "fin_tx_merchant_select"
  on public.financial_transactions
  for select to authenticated
  using (public.get_user_role() = 'MERCHANT' and merchant_id = auth.uid());

-- Admins have full access.
create policy "fin_tx_admin_all"
  on public.financial_transactions
  for all to authenticated
  using (public.get_user_role() = 'ADMIN')
  with check (public.get_user_role() = 'ADMIN');

-- ---------------------------------------------------------------------
-- 3. TRIGGER: auto-create a financial record when a shipment is DELIVERED
-- ---------------------------------------------------------------------
-- Fires only on the transition INTO 'DELIVERED'. merchant_share is computed
-- here in exact numeric arithmetic. Idempotent via the unique shipment_id
-- constraint + ON CONFLICT guard, so re-delivery edge cases can't duplicate.
create or replace function public.handle_shipment_delivered()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status = 'DELIVERED' and old.status is distinct from 'DELIVERED' then
    insert into public.financial_transactions (
      shipment_id,
      driver_id,
      merchant_id,
      amount_collected,
      delivery_fee,
      merchant_share,
      status
    )
    values (
      new.id,
      new.driver_id,
      new.merchant_id,
      new.cod_amount,
      new.delivery_fee,
      new.cod_amount - new.delivery_fee,   -- exact numeric(10,2) subtraction
      'HELD_BY_DRIVER'
    )
    on conflict (shipment_id) do nothing;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_shipment_delivered on public.shipments;
create trigger trg_shipment_delivered
  after update of status on public.shipments
  for each row
  execute function public.handle_shipment_delivered();

-- ---------------------------------------------------------------------
-- 4. FUNCTION: atomic driver cash reconciliation
-- ---------------------------------------------------------------------
-- Moves every HELD_BY_DRIVER row for a driver to SETTLED_WITH_COMPANY in a
-- single transaction, stamping the admin who cleared the cash. Returns a
-- summary including the exact total settled (computed in SQL).
create or replace function public.reconcile_driver_cash(
  p_driver_id uuid,
  p_admin_id  uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count       integer;
  v_total       numeric(10,2);
  v_settled_ids uuid[];
begin
  -- Lock the driver's held rows so a concurrent reconcile can't double-count.
  select array_agg(id), count(*), coalesce(sum(merchant_share), 0)
  into v_settled_ids, v_count, v_total
  from (
    select id, merchant_share
    from public.financial_transactions
    where driver_id = p_driver_id
      and status = 'HELD_BY_DRIVER'
    for update
  ) held;

  if v_count = 0 then
    return jsonb_build_object(
      'success', true,
      'settled_count', 0,
      'total_settled', '0.00',
      'message', 'No cash currently held by this driver.'
    );
  end if;

  update public.financial_transactions
  set status        = 'SETTLED_WITH_COMPANY',
      reconciled_by  = p_admin_id
  where id = any(v_settled_ids);

  return jsonb_build_object(
    'success', true,
    'settled_count', v_count,
    -- Cast to text so the exact decimal survives JSON serialization.
    'total_settled', v_total::text,
    'reconciled_by', p_admin_id,
    'transaction_ids', to_jsonb(v_settled_ids)
  );
end;
$$;

comment on function public.reconcile_driver_cash is
  'Atomically settles all HELD_BY_DRIVER transactions for a driver, stamping the clearing admin.';

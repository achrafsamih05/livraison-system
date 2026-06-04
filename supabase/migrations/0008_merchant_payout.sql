-- =====================================================================
-- Logistics Platform — Phase 7 (final): Merchant Payout
-- Target: Supabase (PostgreSQL). Safe to re-run.
--
-- Completes the financial loop:
--   HELD_BY_DRIVER -> SETTLED_WITH_COMPANY -> PAID_TO_MERCHANT
--
-- Precision policy unchanged: all sums computed in SQL over numeric(10,2),
-- returned to the API as text. JavaScript never does money arithmetic.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Payout audit columns on financial_transactions
-- ---------------------------------------------------------------------
alter table public.financial_transactions
  add column if not exists paid_by          uuid references public.profiles (id),
  add column if not exists payout_method    text
    check (payout_method is null or payout_method in ('BANK_TRANSFER', 'CASH')),
  add column if not exists payout_reference text,
  add column if not exists paid_at          timestamptz;

comment on column public.financial_transactions.paid_by is
  'Admin who processed the merchant payout (set when status -> PAID_TO_MERCHANT).';

-- ---------------------------------------------------------------------
-- 2. Merchant cleared-balance metrics (exact SQL sums, returned as text)
-- ---------------------------------------------------------------------
create or replace function public.merchant_cleared_balance(
  p_merchant_id uuid
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'pending_clearance', coalesce(sum(merchant_share) filter (where status = 'HELD_BY_DRIVER'), 0)::text,
    'pending_count',     count(*) filter (where status = 'HELD_BY_DRIVER'),
    'available_for_payout', coalesce(sum(merchant_share) filter (where status = 'SETTLED_WITH_COMPANY'), 0)::text,
    'available_count',   count(*) filter (where status = 'SETTLED_WITH_COMPANY')
  )
  from public.financial_transactions
  where merchant_id = p_merchant_id;
$$;

comment on function public.merchant_cleared_balance is
  'Returns a merchant''s pending (held) and available (settled) balances as exact text amounts.';

-- ---------------------------------------------------------------------
-- 3. Atomic merchant payout
-- ---------------------------------------------------------------------
-- Pays out every SETTLED_WITH_COMPANY transaction for a merchant in a single
-- transaction: flips them to PAID_TO_MERCHANT and stamps the processing admin,
-- method, reference, and timestamp. All-or-nothing. Raises if nothing is
-- available so the caller can surface a clean "no funds" error.
create or replace function public.process_merchant_payout(
  p_merchant_id      uuid,
  p_admin_id         uuid,
  p_payout_method    text,
  p_payout_reference text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count    integer;
  v_total    numeric(10,2);
  v_tx_ids   uuid[];
  v_paid_at  timestamptz := now();
begin
  -- Lock the merchant's payable rows so a concurrent payout can't double-pay.
  select array_agg(id), count(*), coalesce(sum(merchant_share), 0)
  into v_tx_ids, v_count, v_total
  from (
    select id, merchant_share
    from public.financial_transactions
    where merchant_id = p_merchant_id
      and status = 'SETTLED_WITH_COMPANY'
    for update
  ) payable;

  -- No funds available -> raise so the service returns a clear error.
  if v_count = 0 then
    raise exception 'No funds available for payout for merchant %.', p_merchant_id
      using errcode = 'P0001';
  end if;

  update public.financial_transactions
  set status           = 'PAID_TO_MERCHANT',
      paid_by          = p_admin_id,
      payout_method    = p_payout_method,
      payout_reference = p_payout_reference,
      paid_at          = v_paid_at
  where id = any(v_tx_ids);

  return jsonb_build_object(
    'success', true,
    'paid_count', v_count,
    'total_paid', v_total::text,   -- exact decimal as text
    'merchant_id', p_merchant_id,
    'paid_by', p_admin_id,
    'payout_method', p_payout_method,
    'payout_reference', p_payout_reference,
    'paid_at', v_paid_at,
    'transaction_ids', to_jsonb(v_tx_ids)
  );
end;
$$;

comment on function public.process_merchant_payout is
  'Atomically pays out all SETTLED_WITH_COMPANY transactions for a merchant; '
  'raises P0001 when no funds are available.';

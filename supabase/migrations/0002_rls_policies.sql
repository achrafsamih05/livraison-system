-- =====================================================================
-- Logistics Platform — Phase 3.5: Row Level Security (RLS) & Policies
-- Target: Supabase (PostgreSQL)
--
-- Threat model: tables are reachable through Supabase's PostgREST API
-- using the public anon key. These policies enforce per-role, per-row
-- access so the API cannot be exploited directly.
--
-- IMPORTANT: the trusted Express backend must use the SERVICE_ROLE key,
-- which bypasses RLS. The anon key alone (a normal user JWT) is governed
-- entirely by the policies below.
--
-- Safe to re-run: policies are dropped before being recreated.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 0. HELPER FUNCTION — fetch the caller's role WITHOUT recursing into RLS
-- ---------------------------------------------------------------------
-- SECURITY DEFINER lets this function read public.profiles while bypassing
-- RLS. This is essential: if it were SECURITY INVOKER, a policy on
-- profiles that calls this function would recurse infinitely.
-- A pinned empty search_path prevents search-path hijacking.

create or replace function public.get_user_role()
returns public.user_role
language sql
stable
security definer
set search_path = ''
as $$
  select role
  from public.profiles
  where id = auth.uid();
$$;

comment on function public.get_user_role() is
  'Returns the app role of the currently authenticated user (auth.uid()). '
  'SECURITY DEFINER to avoid recursive RLS evaluation on profiles.';

-- ---------------------------------------------------------------------
-- 1. ENABLE ROW LEVEL SECURITY
-- ---------------------------------------------------------------------
alter table public.profiles      enable row level security;
alter table public.inventory     enable row level security;
alter table public.shipments     enable row level security;
alter table public.tracking_logs enable row level security;

-- =====================================================================
-- 2. PROFILES POLICIES
-- =====================================================================
drop policy if exists "profiles_select_own"   on public.profiles;
drop policy if exists "profiles_admin_all"     on public.profiles;

-- Users may read only their own profile row.
create policy "profiles_select_own"
  on public.profiles
  for select
  to authenticated
  using (auth.uid() = id);

-- Admins have full read/write across all profiles.
-- (The backend service_role bypasses RLS entirely, so no policy is needed
--  for server-side writes such as the signup-trigger profile creation.)
create policy "profiles_admin_all"
  on public.profiles
  for all
  to authenticated
  using (public.get_user_role() = 'ADMIN')
  with check (public.get_user_role() = 'ADMIN');

-- =====================================================================
-- 3. SHIPMENTS POLICIES
-- =====================================================================
drop policy if exists "shipments_staff_all"        on public.shipments;
drop policy if exists "shipments_merchant_select"  on public.shipments;
drop policy if exists "shipments_merchant_insert"  on public.shipments;
drop policy if exists "shipments_driver_select"    on public.shipments;
drop policy if exists "shipments_driver_update"    on public.shipments;

-- WAREHOUSE_AGENT & ADMIN: full access (sort, receive, dispatch).
create policy "shipments_staff_all"
  on public.shipments
  for all
  to authenticated
  using (public.get_user_role() in ('ADMIN', 'WAREHOUSE_AGENT'))
  with check (public.get_user_role() in ('ADMIN', 'WAREHOUSE_AGENT'));

-- MERCHANT: read own shipments.
create policy "shipments_merchant_select"
  on public.shipments
  for select
  to authenticated
  using (
    public.get_user_role() = 'MERCHANT'
    and merchant_id = auth.uid()
  );

-- MERCHANT: create own shipments, and only as DRAFT (they cannot set
-- a live status directly — status transitions are a warehouse concern).
create policy "shipments_merchant_insert"
  on public.shipments
  for insert
  to authenticated
  with check (
    public.get_user_role() = 'MERCHANT'
    and merchant_id = auth.uid()
    and status = 'DRAFT'
  );

-- DRIVER: read shipments assigned to them.
create policy "shipments_driver_select"
  on public.shipments
  for select
  to authenticated
  using (
    public.get_user_role() = 'DRIVER'
    and driver_id = auth.uid()
  );

-- DRIVER: update shipments assigned to them. Column-level protection
-- (status only, never financial fields) is enforced by the trigger below,
-- because RLS cannot compare OLD vs NEW values.
create policy "shipments_driver_update"
  on public.shipments
  for update
  to authenticated
  using (
    public.get_user_role() = 'DRIVER'
    and driver_id = auth.uid()
  )
  with check (
    public.get_user_role() = 'DRIVER'
    and driver_id = auth.uid()
  );

-- 3.1 Column-level guard: drivers may change ONLY the status column.
create or replace function public.protect_shipment_columns()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role public.user_role := public.get_user_role();
begin
  -- Only constrain drivers. Staff (admin/warehouse) and the service_role
  -- backend (v_role IS NULL) are unrestricted here.
  if v_role = 'DRIVER' then
    if  new.cod_amount       is distinct from old.cod_amount
     or new.delivery_fee     is distinct from old.delivery_fee
     or new.merchant_id      is distinct from old.merchant_id
     or new.driver_id        is distinct from old.driver_id
     or new.tracking_number  is distinct from old.tracking_number
     or new.customer_name    is distinct from old.customer_name
     or new.customer_phone   is distinct from old.customer_phone
     or new.customer_address is distinct from old.customer_address
     or new.city             is distinct from old.city
     or new.district         is distinct from old.district
     or new.created_at       is distinct from old.created_at
    then
      raise exception
        'Drivers may only update the shipment status, not financial or order fields.';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_protect_shipment_columns on public.shipments;
create trigger trg_protect_shipment_columns
  before update on public.shipments
  for each row
  execute function public.protect_shipment_columns();

-- =====================================================================
-- 4. INVENTORY POLICIES
-- =====================================================================
drop policy if exists "inventory_merchant_all"    on public.inventory;
drop policy if exists "inventory_staff_select"     on public.inventory;
drop policy if exists "inventory_staff_update"     on public.inventory;

-- MERCHANT: full CRUD on their own inventory.
create policy "inventory_merchant_all"
  on public.inventory
  for all
  to authenticated
  using (
    public.get_user_role() = 'MERCHANT'
    and merchant_id = auth.uid()
  )
  with check (
    public.get_user_role() = 'MERCHANT'
    and merchant_id = auth.uid()
  );

-- WAREHOUSE_AGENT & ADMIN: read all inventory.
create policy "inventory_staff_select"
  on public.inventory
  for select
  to authenticated
  using (public.get_user_role() in ('ADMIN', 'WAREHOUSE_AGENT'));

-- WAREHOUSE_AGENT & ADMIN: update inventory (column-level limits for
-- warehouse agents enforced by the trigger below).
create policy "inventory_staff_update"
  on public.inventory
  for update
  to authenticated
  using (public.get_user_role() in ('ADMIN', 'WAREHOUSE_AGENT'))
  with check (public.get_user_role() in ('ADMIN', 'WAREHOUSE_AGENT'));

-- 4.1 Column-level guard: warehouse agents may change ONLY quantity and
--     location. Admins remain unrestricted.
create or replace function public.protect_inventory_columns()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role public.user_role := public.get_user_role();
begin
  if v_role = 'WAREHOUSE_AGENT' then
    if  new.sku         is distinct from old.sku
     or new.name        is distinct from old.name
     or new.barcode     is distinct from old.barcode
     or new.merchant_id is distinct from old.merchant_id
    then
      raise exception
        'Warehouse agents may only update quantity_available and warehouse_location.';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_protect_inventory_columns on public.inventory;
create trigger trg_protect_inventory_columns
  before update on public.inventory
  for each row
  execute function public.protect_inventory_columns();

-- =====================================================================
-- 5. TRACKING_LOGS POLICIES (immutable audit trail)
-- =====================================================================
drop policy if exists "tracking_logs_worker_insert"  on public.tracking_logs;
drop policy if exists "tracking_logs_merchant_select" on public.tracking_logs;

-- Workers (DRIVER, WAREHOUSE_AGENT, ADMIN) may append log rows, and only
-- under their own identity (updated_by must equal the caller).
create policy "tracking_logs_worker_insert"
  on public.tracking_logs
  for insert
  to authenticated
  with check (
    public.get_user_role() in ('DRIVER', 'WAREHOUSE_AGENT', 'ADMIN')
    and updated_by = auth.uid()
  );

-- MERCHANT: read the log history for their own shipments.
create policy "tracking_logs_merchant_select"
  on public.tracking_logs
  for select
  to authenticated
  using (
    public.get_user_role() = 'MERCHANT'
    and exists (
      select 1
      from public.shipments s
      where s.id = tracking_logs.shipment_id
        and s.merchant_id = auth.uid()
    )
  );

-- No UPDATE or DELETE policy exists, so those are denied for every API
-- user. To make the trail truly immutable even against the service_role
-- backend, block mutation at the trigger level as well.
create or replace function public.prevent_audit_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception
    'tracking_logs is an immutable audit trail; % is not permitted.', tg_op;
end;
$$;

drop trigger if exists trg_tracking_logs_no_update on public.tracking_logs;
create trigger trg_tracking_logs_no_update
  before update on public.tracking_logs
  for each row
  execute function public.prevent_audit_mutation();

drop trigger if exists trg_tracking_logs_no_delete on public.tracking_logs;
create trigger trg_tracking_logs_no_delete
  before delete on public.tracking_logs
  for each row
  execute function public.prevent_audit_mutation();

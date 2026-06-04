-- =====================================================================
-- Logistics Platform — Phase 2: Database Schema & Relationships
-- Target: Supabase (PostgreSQL)
--
-- Safe to run inside the Supabase SQL Editor. Statements are written
-- idempotently where practical so the script can be re-run during setup.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. CUSTOM ENUM TYPES
-- ---------------------------------------------------------------------
-- Wrapped in DO blocks so re-running the script doesn't error if the
-- types already exist.

do $$
begin
  if not exists (select 1 from pg_type where typname = 'user_role') then
    create type public.user_role as enum (
      'ADMIN',
      'MERCHANT',
      'WAREHOUSE_AGENT',
      'DRIVER'
    );
  end if;
end$$;

do $$
begin
  if not exists (select 1 from pg_type where typname = 'shipment_status') then
    create type public.shipment_status as enum (
      'DRAFT',
      'ASSIGNED_FOR_RAMASSE',
      'RAMASSE',
      'RECEPTION',
      'EN_TRANSIT',
      'OUT_FOR_DELIVERY',
      'DELIVERED',
      'RETURNED'
    );
  end if;
end$$;

-- ---------------------------------------------------------------------
-- 2. CORE TABLES
-- ---------------------------------------------------------------------

-- 2.1 profiles — extends Supabase auth.users with app-specific data.
create table if not exists public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  name        text not null,
  phone       text,
  role        public.user_role not null default 'DRIVER',
  created_at  timestamptz not null default now()
);

comment on table public.profiles is 'Application profile data, one row per auth.users record.';

-- 2.2 inventory — Ozon-like merchant fulfillment stock.
create table if not exists public.inventory (
  id                  uuid primary key default gen_random_uuid(),
  merchant_id         uuid not null references public.profiles (id),
  sku                 text not null unique,
  name                text not null,
  barcode             text not null unique,
  quantity_available  integer not null default 0 check (quantity_available >= 0),
  warehouse_location  text,                       -- e.g. 'A-04-B'
  updated_at          timestamptz not null default now()
);

comment on table public.inventory is 'Per-merchant stock held in the warehouse for fulfillment.';

-- 2.3 shipments — the central delivery order entity.
create table if not exists public.shipments (
  id                uuid primary key default gen_random_uuid(),
  tracking_number   text not null unique,          -- e.g. 'FX-12345678'
  merchant_id       uuid not null references public.profiles (id),
  driver_id         uuid references public.profiles (id),  -- nullable until assigned
  customer_name     text not null,
  customer_phone    text not null,
  customer_address  text not null,
  city              text not null,
  district          text not null,                 -- used for manual sorting
  status            public.shipment_status not null default 'DRAFT',
  cod_amount        numeric(10,2) not null default 0.00,   -- Cash On Delivery
  delivery_fee      numeric(10,2) not null default 0.00,
  created_at        timestamptz not null default now()
);

comment on table public.shipments is 'Delivery orders moving through the logistics pipeline.';

-- 2.4 tracking_logs — immutable audit trail of every status change.
create table if not exists public.tracking_logs (
  id            uuid primary key default gen_random_uuid(),
  shipment_id   uuid not null references public.shipments (id) on delete cascade,
  status        public.shipment_status not null,
  updated_by    uuid not null references public.profiles (id),  -- who scanned it
  timestamp     timestamptz not null default now()
);

comment on table public.tracking_logs is 'Append-only history of shipment status transitions.';

-- ---------------------------------------------------------------------
-- 3. INDEXES (foreign keys + frequent lookups)
-- ---------------------------------------------------------------------
-- Postgres does NOT auto-index foreign keys. These speed up joins and
-- the common "find by X" queries the API will run.

create index if not exists idx_inventory_merchant_id      on public.inventory (merchant_id);
create index if not exists idx_shipments_merchant_id      on public.shipments (merchant_id);
create index if not exists idx_shipments_driver_id        on public.shipments (driver_id);
create index if not exists idx_shipments_status           on public.shipments (status);
create index if not exists idx_shipments_district         on public.shipments (district);
create index if not exists idx_tracking_logs_shipment_id  on public.tracking_logs (shipment_id);
create index if not exists idx_tracking_logs_updated_by   on public.tracking_logs (updated_by);

-- ---------------------------------------------------------------------
-- 4. TRIGGERS
-- ---------------------------------------------------------------------

-- 4.1 Auto-create a profile whenever a new auth user signs up.
--     SECURITY DEFINER lets the function insert into public.profiles
--     even though the signup runs in the auth context.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, name, phone, role)
  values (
    new.id,
    -- Prefer a name supplied at signup; fall back to email so NOT NULL holds.
    coalesce(new.raw_user_meta_data ->> 'name', new.email, 'New User'),
    new.raw_user_meta_data ->> 'phone',
    -- Allow an explicit role in signup metadata; otherwise default to DRIVER.
    coalesce(
      (new.raw_user_meta_data ->> 'role')::public.user_role,
      'DRIVER'::public.user_role
    )
  );
  return new;
end;
$$;

-- Recreate the trigger cleanly on re-run.
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row
  execute function public.handle_new_user();

-- 4.2 Keep inventory.updated_at fresh on every update.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_inventory_updated_at on public.inventory;
create trigger trg_inventory_updated_at
  before update on public.inventory
  for each row
  execute function public.set_updated_at();

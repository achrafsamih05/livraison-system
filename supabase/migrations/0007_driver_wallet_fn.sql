-- =====================================================================
-- Logistics Platform — Phase 7: Driver wallet total (exact SQL sum)
-- Target: Supabase (PostgreSQL). Safe to re-run.
--
-- Computes the exact total cash a driver is currently holding. The sum is
-- done in SQL over numeric(10,2) and returned as text so JavaScript never
-- performs float arithmetic on money.
-- =====================================================================

create or replace function public.driver_wallet_total(
  p_driver_id uuid
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'held_count', count(*),
    'total_held', coalesce(sum(merchant_share), 0)::text
  )
  from public.financial_transactions
  where driver_id = p_driver_id
    and status = 'HELD_BY_DRIVER';
$$;

comment on function public.driver_wallet_total is
  'Returns exact held cash total (as text) and count for a driver.';

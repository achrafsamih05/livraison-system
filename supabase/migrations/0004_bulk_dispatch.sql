-- =====================================================================
-- Logistics Platform — Phase 6: Manual Sorting & Bulk Dispatching
-- Target: Supabase (PostgreSQL)
--
-- Provides bulk_assign_driver(): atomically assigns a driver to a batch of
-- shipments and dispatches them to OUT_FOR_DELIVERY, writing an audit log
-- per shipment.
--
-- ATOMICITY CONTRACT (differs from the scan engine):
--   The scan engine isolates each item so one bad barcode doesn't abort the
--   batch. Bulk dispatch is the OPPOSITE: it is all-or-nothing. If ANY
--   shipment fails validation, the whole function raises and the entire
--   transaction rolls back. No partial dispatch.
-- =====================================================================

create or replace function public.bulk_assign_driver(
  p_shipment_ids uuid[],
  p_driver_id    uuid,
  p_operator_id  uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_driver_role public.user_role;
  v_expected    integer := array_length(p_shipment_ids, 1);
  v_locked      integer;
  v_invalid     text;
begin
  -- Guard: empty batch.
  if v_expected is null or v_expected = 0 then
    raise exception 'No shipment IDs provided.';
  end if;

  -- 1. Validate the driver exists and is actually a DRIVER.
  select role into v_driver_role
  from public.profiles
  where id = p_driver_id;

  if not found then
    raise exception 'Driver % does not exist.', p_driver_id;
  end if;

  if v_driver_role <> 'DRIVER' then
    raise exception 'User % is not a DRIVER (role: %).', p_driver_id, v_driver_role;
  end if;

  -- 2. Lock the candidate rows so concurrent dispatchers can't double-assign.
  --    We only accept shipments that are eligible: status = RECEPTION and
  --    not already assigned to a driver.
  select count(*) into v_locked
  from public.shipments
  where id = any(p_shipment_ids)
    and status = 'RECEPTION'
    and driver_id is null
  for update;

  -- 3. All-or-nothing: every requested shipment must be eligible. If the
  --    eligible count doesn't match the requested count, find the first
  --    offender for a clear error message and abort (rolls back).
  if v_locked <> v_expected then
    select string_agg(reason, '; ') into v_invalid
    from (
      select case
               when s.id is null then format('%s: not found', req.id)
               when s.status <> 'RECEPTION' then
                 format('%s: status is %s (must be RECEPTION)', req.id, s.status)
               when s.driver_id is not null then
                 format('%s: already assigned to a driver', req.id)
               else format('%s: ineligible', req.id)
             end as reason
      from unnest(p_shipment_ids) as req(id)
      left join public.shipments s on s.id = req.id
      where s.id is null
         or s.status <> 'RECEPTION'
         or s.driver_id is not null
    ) offenders;

    raise exception 'Bulk assignment aborted; no changes applied. Ineligible shipments: %', v_invalid;
  end if;

  -- 4. Apply the assignment + dispatch.
  update public.shipments
  set driver_id = p_driver_id,
      status    = 'OUT_FOR_DELIVERY'
  where id = any(p_shipment_ids);

  -- 5. Write one audit-trail row per dispatched shipment.
  insert into public.tracking_logs (shipment_id, status, updated_by)
  select unnest(p_shipment_ids), 'OUT_FOR_DELIVERY'::public.shipment_status, p_operator_id;

  return jsonb_build_object(
    'success', true,
    'assigned_count', v_expected,
    'driver_id', p_driver_id,
    'shipment_ids', to_jsonb(p_shipment_ids)
  );
end;
$$;

comment on function public.bulk_assign_driver is
  'Atomically assigns a driver to a batch of RECEPTION shipments and '
  'dispatches them to OUT_FOR_DELIVERY. All-or-nothing: any ineligible '
  'shipment aborts the whole transaction.';

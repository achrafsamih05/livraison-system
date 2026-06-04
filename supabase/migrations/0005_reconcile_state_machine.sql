-- =====================================================================
-- Logistics Platform — Phase 6 (reconciliation)
-- Allow RECEPTION -> OUT_FOR_DELIVERY (local last-mile) IN ADDITION TO
-- RECEPTION -> EN_TRANSIT (inter-city transport), and make the bulk-assign
-- function share the SAME state-machine rule as the single-scan path.
-- Target: Supabase (PostgreSQL). Safe to re-run.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Update the authoritative state machine.
-- ---------------------------------------------------------------------
create or replace function public.is_valid_status_transition(
  p_from public.shipment_status,
  p_to   public.shipment_status
)
returns boolean
language sql
immutable
as $$
  select case p_from
    when 'DRAFT'                then p_to = 'ASSIGNED_FOR_RAMASSE'
    when 'ASSIGNED_FOR_RAMASSE' then p_to = 'RAMASSE'
    when 'RAMASSE'              then p_to = 'RECEPTION'
    -- RECEPTION can now branch two ways:
    --   EN_TRANSIT       -> inter-city transport
    --   OUT_FOR_DELIVERY -> local, same-city last-mile delivery
    when 'RECEPTION'            then p_to in ('EN_TRANSIT', 'OUT_FOR_DELIVERY')
    when 'EN_TRANSIT'           then p_to = 'OUT_FOR_DELIVERY'
    when 'OUT_FOR_DELIVERY'     then p_to in ('DELIVERED', 'RETURNED')
    -- DELIVERED and RETURNED are terminal states.
    else false
  end;
$$;

-- ---------------------------------------------------------------------
-- 2. Refactor bulk_assign_driver to DELEGATE eligibility to the validator.
--    Previously it hardcoded `status = 'RECEPTION'`. Now it asks the state
--    machine whether `status -> OUT_FOR_DELIVERY` is allowed, so the bulk
--    path and the single-scan path enforce one identical rule.
-- ---------------------------------------------------------------------
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
  v_eligible    integer;
  v_invalid     text;
begin
  -- Guard: empty batch.
  if v_expected is null or v_expected = 0 then
    raise exception 'No shipment IDs provided.';
  end if;

  -- Validate the driver exists and is actually a DRIVER.
  select role into v_driver_role
  from public.profiles
  where id = p_driver_id;

  if not found then
    raise exception 'Driver % does not exist.', p_driver_id;
  end if;

  if v_driver_role <> 'DRIVER' then
    raise exception 'User % is not a DRIVER (role: %).', p_driver_id, v_driver_role;
  end if;

  -- Lock candidate rows. A shipment is eligible when it is unassigned AND
  -- the state machine permits its current status -> OUT_FOR_DELIVERY.
  select count(*) into v_eligible
  from public.shipments
  where id = any(p_shipment_ids)
    and driver_id is null
    and public.is_valid_status_transition(status, 'OUT_FOR_DELIVERY')
  for update;

  -- All-or-nothing: every requested shipment must be eligible.
  if v_eligible <> v_expected then
    select string_agg(reason, '; ') into v_invalid
    from (
      select case
               when s.id is null then format('%s: not found', req.id)
               when s.driver_id is not null then
                 format('%s: already assigned to a driver', req.id)
               when not public.is_valid_status_transition(s.status, 'OUT_FOR_DELIVERY') then
                 format('%s: cannot dispatch from status %s', req.id, s.status)
               else format('%s: ineligible', req.id)
             end as reason
      from unnest(p_shipment_ids) as req(id)
      left join public.shipments s on s.id = req.id
      where s.id is null
         or s.driver_id is not null
         or not public.is_valid_status_transition(s.status, 'OUT_FOR_DELIVERY')
    ) offenders;

    raise exception 'Bulk assignment aborted; no changes applied. Ineligible shipments: %', v_invalid;
  end if;

  -- Apply the assignment + dispatch.
  update public.shipments
  set driver_id = p_driver_id,
      status    = 'OUT_FOR_DELIVERY'
  where id = any(p_shipment_ids);

  -- Write one audit-trail row per dispatched shipment.
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

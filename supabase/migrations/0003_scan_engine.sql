-- =====================================================================
-- Logistics Platform — Phase 5: Status Engine & Barcode Scanning
-- Target: Supabase (PostgreSQL)
--
-- Provides:
--   1. is_valid_status_transition() — the authoritative state machine.
--   2. process_shipment_scans()     — atomic, per-item bulk scan handler.
--
-- Why an RPC? The supabase-js client cannot wrap multiple statements in a
-- single transaction from Node. A PL/pgSQL function runs inside one
-- transaction, and a per-item BEGIN/EXCEPTION block acts as a SAVEPOINT so
-- one bad barcode rolls back only itself while the rest of the batch
-- still commits. This is exactly what bulk scanning needs.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. STATE MACHINE — valid status transitions
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
    when 'RECEPTION'            then p_to = 'EN_TRANSIT'
    when 'EN_TRANSIT'           then p_to = 'OUT_FOR_DELIVERY'
    when 'OUT_FOR_DELIVERY'     then p_to in ('DELIVERED', 'RETURNED')
    -- DELIVERED and RETURNED are terminal states.
    else false
  end;
$$;

comment on function public.is_valid_status_transition is
  'Authoritative shipment state machine. Returns true if p_from -> p_to is allowed.';

-- ---------------------------------------------------------------------
-- 2. ATOMIC BULK SCAN HANDLER
-- ---------------------------------------------------------------------
-- Returns a JSONB array of per-item results:
--   [{ "tracking_number": "...", "success": true,  "status": "RECEPTION" },
--    { "tracking_number": "...", "success": false, "error": "..." }]
create or replace function public.process_shipment_scans(
  p_tracking_numbers text[],
  p_next_status      public.shipment_status,
  p_user_id          uuid,
  p_user_role        public.user_role
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tracking  text;
  v_shipment  public.shipments%rowtype;
  v_results   jsonb := '[]'::jsonb;
  v_driver_id uuid;
begin
  foreach v_tracking in array p_tracking_numbers
  loop
    -- Per-item subtransaction. Any unhandled error inside this block rolls
    -- back ONLY this iteration (implicit SAVEPOINT), then we record the
    -- failure and move on to the next barcode.
    begin
      -- Lock the row to prevent concurrent scanners racing on the same package.
      select * into v_shipment
      from public.shipments
      where tracking_number = v_tracking
      for update;

      if not found then
        v_results := v_results || jsonb_build_object(
          'tracking_number', v_tracking,
          'success', false,
          'error', 'Shipment not found.'
        );
        continue;
      end if;

      -- Validate the transition against the state machine.
      if not public.is_valid_status_transition(v_shipment.status, p_next_status) then
        v_results := v_results || jsonb_build_object(
          'tracking_number', v_tracking,
          'success', false,
          'error', format(
            'Invalid status transition: %s -> %s.',
            v_shipment.status, p_next_status
          )
        );
        continue;
      end if;

      -- OUT_FOR_DELIVERY must have a driver attached.
      v_driver_id := v_shipment.driver_id;
      if p_next_status = 'OUT_FOR_DELIVERY' and v_driver_id is null then
        if p_user_role = 'DRIVER' then
          -- The scanning driver takes ownership of the package.
          v_driver_id := p_user_id;
        else
          v_results := v_results || jsonb_build_object(
            'tracking_number', v_tracking,
            'success', false,
            'error', 'OUT_FOR_DELIVERY requires an assigned driver.'
          );
          continue;
        end if;
      end if;

      -- Apply the status change (and driver linkage when relevant).
      update public.shipments
      set status    = p_next_status,
          driver_id = v_driver_id
      where id = v_shipment.id;

      -- Append the immutable audit-trail entry.
      insert into public.tracking_logs (shipment_id, status, updated_by)
      values (v_shipment.id, p_next_status, p_user_id);

      v_results := v_results || jsonb_build_object(
        'tracking_number', v_tracking,
        'success', true,
        'shipment_id', v_shipment.id,
        'status', p_next_status
      );

    exception when others then
      -- Unexpected failure: this iteration is rolled back automatically.
      v_results := v_results || jsonb_build_object(
        'tracking_number', v_tracking,
        'success', false,
        'error', sqlerrm
      );
    end;
  end loop;

  return v_results;
end;
$$;

comment on function public.process_shipment_scans is
  'Atomically applies a status change + audit log to a batch of tracking '
  'numbers. Per-item isolation: one failure does not abort the batch.';

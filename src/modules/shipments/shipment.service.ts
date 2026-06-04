import { supabaseAdmin } from '../../config/supabase';
import { buildTrackingNumber } from '../../shared/utils/trackingNumber';
import { AppError, NotFoundError } from '../../shared/errors/AppError';
import { UserRole } from '../../shared/types/roles';
import {
  Shipment,
  ShipmentStatus,
  CreateShipmentInput,
  PaginationOptions,
  PaginatedResult,
  ScanResult,
  TrackingLogEntry,
  UnassignedFilter,
  LocationGroup,
} from './shipment.types';

/**
 * Maximum attempts to generate a collision-free tracking number before
 * giving up. With a 30-char alphabet over 6 positions (~729M combinations
 * per year) collisions are astronomically unlikely, but we still guard.
 */
const MAX_TRACKING_ATTEMPTS = 5;

/**
 * The shipment state machine, mirrored in TypeScript so the API can reject
 * obviously-invalid requests early with clear messages. The authoritative
 * copy also lives in the database (is_valid_status_transition) and is what
 * actually guards the atomic scan transaction.
 *
 * Keep this table in sync with supabase/migrations/0003_scan_engine.sql.
 */
const STATE_TRANSITIONS: Record<ShipmentStatus, ShipmentStatus[]> = {
  DRAFT: ['ASSIGNED_FOR_RAMASSE'],
  ASSIGNED_FOR_RAMASSE: ['RAMASSE'],
  RAMASSE: ['RECEPTION'],
  RECEPTION: ['EN_TRANSIT', 'OUT_FOR_DELIVERY'],
  EN_TRANSIT: ['OUT_FOR_DELIVERY'],
  OUT_FOR_DELIVERY: ['DELIVERED', 'RETURNED'],
  DELIVERED: [], // terminal
  RETURNED: [], // terminal
};

/**
 * Returns true if moving `from` -> `to` is a permitted transition.
 */
export function isValidStatusTransition(
  from: ShipmentStatus,
  to: ShipmentStatus
): boolean {
  return STATE_TRANSITIONS[from].includes(to);
}

export class ShipmentService {
  /**
   * Generates a tracking number and verifies it does not already exist in
   * the shipments table. Retries on the rare collision.
   */
  private async generateUniqueTrackingNumber(): Promise<string> {
    for (let attempt = 0; attempt < MAX_TRACKING_ATTEMPTS; attempt += 1) {
      const candidate = buildTrackingNumber();

      const { data, error } = await supabaseAdmin
        .from('shipments')
        .select('id')
        .eq('tracking_number', candidate)
        .maybeSingle();

      if (error) {
        throw new AppError(`Failed to verify tracking number uniqueness: ${error.message}`, 500);
      }

      if (!data) {
        return candidate; // No collision — this one is free.
      }
    }

    throw new AppError(
      'Unable to generate a unique tracking number after multiple attempts.',
      500
    );
  }

  /**
   * Creates a shipment owned by the given merchant, then writes the initial
   * DRAFT entry into the tracking_logs audit trail.
   */
  async createShipment(
    merchantId: string,
    input: CreateShipmentInput
  ): Promise<Shipment> {
    const trackingNumber = await this.generateUniqueTrackingNumber();

    const { data: shipment, error } = await supabaseAdmin
      .from('shipments')
      .insert({
        tracking_number: trackingNumber,
        merchant_id: merchantId,
        customer_name: input.customer_name,
        customer_phone: input.customer_phone,
        customer_address: input.customer_address,
        city: input.city,
        district: input.district,
        cod_amount: input.cod_amount,
        status: 'DRAFT',
      })
      .select('*')
      .single();

    if (error || !shipment) {
      throw new AppError(
        `Failed to create shipment: ${error?.message ?? 'unknown error'}`,
        500
      );
    }

    const createdShipment = shipment as Shipment;

    // Write the initial audit-trail entry. If this fails, roll back the
    // shipment so we never leave an order without its opening log.
    const { error: logError } = await supabaseAdmin.from('tracking_logs').insert({
      shipment_id: createdShipment.id,
      status: 'DRAFT',
      updated_by: merchantId,
    });

    if (logError) {
      await supabaseAdmin.from('shipments').delete().eq('id', createdShipment.id);
      throw new AppError(
        `Failed to create initial tracking log; shipment rolled back: ${logError.message}`,
        500
      );
    }

    return createdShipment;
  }

  /**
   * Lists shipments based on the caller's role.
   *  - MERCHANT: only their own shipments.
   *  - ADMIN / WAREHOUSE_AGENT: all shipments, paginated.
   */
  async listShipments(
    userId: string,
    role: UserRole,
    pagination: PaginationOptions
  ): Promise<PaginatedResult<Shipment>> {
    const { page, pageSize } = pagination;
    const from = (page - 1) * pageSize;
    const to = from + pageSize - 1;

    let query = supabaseAdmin
      .from('shipments')
      .select('*', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(from, to);

    // Merchants are scoped to their own records.
    if (role === 'MERCHANT') {
      query = query.eq('merchant_id', userId);
    }

    const { data, error, count } = await query;

    if (error) {
      throw new AppError(`Failed to fetch shipments: ${error.message}`, 500);
    }

    const total = count ?? 0;

    return {
      data: (data ?? []) as Shipment[],
      pagination: {
        page,
        pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / pageSize)),
      },
    };
  }

  /**
   * Fetches a single shipment by tracking number, joined with the owning
   * merchant's profile, and shapes it into label-ready data.
   */
  async getLabelData(trackingNumber: string): Promise<Record<string, unknown>> {
    const { data, error } = await supabaseAdmin
      .from('shipments')
      .select(
        `
        id,
        tracking_number,
        customer_name,
        customer_phone,
        customer_address,
        city,
        district,
        cod_amount,
        status,
        created_at,
        merchant:merchant_id ( id, name, phone )
        `
      )
      .eq('tracking_number', trackingNumber)
      .maybeSingle();

    if (error) {
      throw new AppError(`Failed to fetch label data: ${error.message}`, 500);
    }
    if (!data) {
      throw new NotFoundError(`Shipment not found for tracking number: ${trackingNumber}`);
    }

    const shipment = data as unknown as Shipment & {
      merchant: { id: string; name: string; phone: string | null } | null;
    };

    return {
      tracking_number: shipment.tracking_number,
      // The barcode string encodes the tracking number; a client-side or
      // print service renders it into an actual barcode/QR image.
      barcode: shipment.tracking_number,
      status: shipment.status,
      created_at: shipment.created_at,
      merchant: {
        id: shipment.merchant?.id ?? null,
        name: shipment.merchant?.name ?? null,
        phone: shipment.merchant?.phone ?? null,
      },
      customer: {
        name: shipment.customer_name,
        phone: shipment.customer_phone,
        address: shipment.customer_address,
      },
      destination: {
        city: shipment.city,
        district: shipment.district,
      },
      cod_amount: shipment.cod_amount,
    };
  }

  /**
   * Processes a single or bulk barcode scan atomically via the database
   * RPC `process_shipment_scans`. Each tracking number is handled in its
   * own subtransaction: validation, status update, and audit-log insert
   * either all succeed for that item or are rolled back together. One bad
   * barcode never aborts the rest of the batch.
   *
   * Returns a per-item result array so the scanner UI can report exactly
   * which packages succeeded and which violated the state machine.
   */
  async processScans(
    trackingNumbers: string[],
    nextStatus: ShipmentStatus,
    userId: string,
    role: UserRole
  ): Promise<ScanResult[]> {
    const { data, error } = await supabaseAdmin.rpc('process_shipment_scans', {
      p_tracking_numbers: trackingNumbers,
      p_next_status: nextStatus,
      p_user_id: userId,
      p_user_role: role,
    });

    if (error) {
      throw new AppError(`Scan operation failed: ${error.message}`, 500);
    }

    return (data ?? []) as ScanResult[];
  }

  /**
   * Returns the full chronological lifecycle of a package: the shipment
   * summary plus all tracking_logs rows sorted oldest-first.
   */
  async getHistory(trackingNumber: string): Promise<{
    shipment: Partial<Shipment>;
    history: TrackingLogEntry[];
  }> {
    const { data: shipment, error: shipmentError } = await supabaseAdmin
      .from('shipments')
      .select(
        'id, tracking_number, status, customer_name, city, district, created_at'
      )
      .eq('tracking_number', trackingNumber)
      .maybeSingle();

    if (shipmentError) {
      throw new AppError(`Failed to fetch shipment: ${shipmentError.message}`, 500);
    }
    if (!shipment) {
      throw new NotFoundError(
        `Shipment not found for tracking number: ${trackingNumber}`
      );
    }

    const { data: logs, error: logsError } = await supabaseAdmin
      .from('tracking_logs')
      .select('id, status, updated_by, timestamp')
      .eq('shipment_id', (shipment as { id: string }).id)
      .order('timestamp', { ascending: true });

    if (logsError) {
      throw new AppError(`Failed to fetch tracking history: ${logsError.message}`, 500);
    }

    return {
      shipment: shipment as Partial<Shipment>,
      history: (logs ?? []) as TrackingLogEntry[],
    };
  }

  /**
   * Dispatcher view: shipments sitting in the warehouse (status = RECEPTION)
   * with no driver assigned yet. Supports optional city/district filtering
   * and pagination. Also returns location groupings so the operator can see
   * how many packages are waiting per neighborhood (e.g. "Casablanca -> Maarif").
   */
  async getUnassignedShipments(filter: UnassignedFilter): Promise<
    PaginatedResult<Shipment> & { groups: LocationGroup[] }
  > {
    const { city, district, page, pageSize } = filter;
    const from = (page - 1) * pageSize;
    const to = from + pageSize - 1;

    // --- Paginated list of the actual shipments ---
    let listQuery = supabaseAdmin
      .from('shipments')
      .select('*', { count: 'exact' })
      .eq('status', 'RECEPTION')
      .is('driver_id', null)
      .order('city', { ascending: true })
      .order('district', { ascending: true })
      .order('created_at', { ascending: true })
      .range(from, to);

    if (city) listQuery = listQuery.eq('city', city);
    if (district) listQuery = listQuery.eq('district', district);

    const { data, error, count } = await listQuery;

    if (error) {
      throw new AppError(`Failed to fetch unassigned shipments: ${error.message}`, 500);
    }

    // --- Location groupings (counts per city/district) ---
    // Pulls just the location columns for ALL matching rows so the dispatcher
    // dashboard can show neighborhood totals independent of the current page.
    let groupQuery = supabaseAdmin
      .from('shipments')
      .select('city, district')
      .eq('status', 'RECEPTION')
      .is('driver_id', null);

    if (city) groupQuery = groupQuery.eq('city', city);
    if (district) groupQuery = groupQuery.eq('district', district);

    const { data: groupRows, error: groupError } = await groupQuery;

    if (groupError) {
      throw new AppError(`Failed to compute location groups: ${groupError.message}`, 500);
    }

    const groupMap = new Map<string, LocationGroup>();
    for (const row of (groupRows ?? []) as Array<{ city: string; district: string }>) {
      const key = `${row.city}||${row.district}`;
      const existing = groupMap.get(key);
      if (existing) {
        existing.count += 1;
      } else {
        groupMap.set(key, { city: row.city, district: row.district, count: 1 });
      }
    }

    const groups = Array.from(groupMap.values()).sort(
      (a, b) => b.count - a.count || a.city.localeCompare(b.city)
    );

    const total = count ?? 0;

    return {
      data: (data ?? []) as Shipment[],
      pagination: {
        page,
        pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / pageSize)),
      },
      groups,
    };
  }

  /**
   * Atomically assigns a driver to a batch of shipments and dispatches them
   * to OUT_FOR_DELIVERY via the `bulk_assign_driver` RPC.
   *
   * All-or-nothing: if the driver is invalid or ANY shipment is ineligible
   * (not found, not in RECEPTION, or already assigned), the database
   * function raises and the entire transaction rolls back — no partial
   * dispatch, no orphaned audit logs.
   */
  async bulkAssignDriver(
    shipmentIds: string[],
    driverId: string,
    operatorId: string
  ): Promise<{ assigned_count: number; driver_id: string; shipment_ids: string[] }> {
    const { data, error } = await supabaseAdmin.rpc('bulk_assign_driver', {
      p_shipment_ids: shipmentIds,
      p_driver_id: driverId,
      p_operator_id: operatorId,
    });

    if (error) {
      // The RPC raises a descriptive exception on validation failure; surface
      // it as a 400 so the operator sees exactly which shipments were bad.
      throw new AppError(`Bulk assignment failed: ${error.message}`, 400);
    }

    const result = data as {
      assigned_count: number;
      driver_id: string;
      shipment_ids: string[];
    };

    return result;
  }
}

export const shipmentService = new ShipmentService();

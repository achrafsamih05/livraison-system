/**
 * Shipment status values. Mirrors the `shipment_status` enum in the
 * database migration (0001_initial_schema.sql). Keep in sync.
 */
export const SHIPMENT_STATUSES = [
  'DRAFT',
  'ASSIGNED_FOR_RAMASSE',
  'RAMASSE',
  'RECEPTION',
  'EN_TRANSIT',
  'OUT_FOR_DELIVERY',
  'DELIVERED',
  'RETURNED',
] as const;

export type ShipmentStatus = (typeof SHIPMENT_STATUSES)[number];

/**
 * Full shipment row as stored in the database.
 */
export interface Shipment {
  id: string;
  tracking_number: string;
  merchant_id: string;
  driver_id: string | null;
  customer_name: string;
  customer_phone: string;
  customer_address: string;
  city: string;
  district: string;
  status: ShipmentStatus;
  cod_amount: number;
  delivery_fee: number;
  created_at: string;
}

/**
 * Validated payload accepted by POST /api/shipments.
 */
export interface CreateShipmentInput {
  customer_name: string;
  customer_phone: string;
  customer_address: string;
  city: string;
  district: string;
  cod_amount: number;
}

export interface PaginationOptions {
  page: number;
  pageSize: number;
}

export interface PaginatedResult<T> {
  data: T[];
  pagination: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
  };
}

/**
 * Validated payload accepted by PATCH /api/shipments/scan.
 */
export interface ScanInput {
  trackingNumbers: string[];
  nextStatus: ShipmentStatus;
}

/**
 * Per-item outcome returned by the atomic scan RPC.
 */
export interface ScanResult {
  tracking_number: string;
  success: boolean;
  status?: ShipmentStatus;
  shipment_id?: string;
  error?: string;
}

/**
 * A single tracking_logs row enriched for history responses.
 */
export interface TrackingLogEntry {
  id: string;
  status: ShipmentStatus;
  updated_by: string;
  timestamp: string;
}

/**
 * Filters for the unassigned-shipments dispatcher view.
 */
export interface UnassignedFilter {
  city?: string;
  district?: string;
  page: number;
  pageSize: number;
}

/**
 * Validated payload for POST /api/shipments/bulk-assign.
 */
export interface BulkAssignInput {
  shipmentIds: string[];
  driverId: string;
}

/**
 * A location group for the dispatcher dashboard, e.g. "Casablanca -> Maarif".
 */
export interface LocationGroup {
  city: string;
  district: string;
  count: number;
}

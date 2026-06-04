import { Request, Response } from 'express';
import { shipmentService } from './shipment.service';
import { BadRequestError, UnauthorizedError } from '../../shared/errors/AppError';
import { CreateShipmentInput, ScanInput, BulkAssignInput } from './shipment.types';
import { SHIPMENT_STATUSES, ShipmentStatus } from './shipment.types';

const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 20;

/**
 * Validates and normalizes the create-shipment request body.
 * Throws BadRequestError on the first problem found.
 */
function parseCreateInput(body: unknown): CreateShipmentInput {
  if (typeof body !== 'object' || body === null) {
    throw new BadRequestError('Request body must be a JSON object.');
  }

  const b = body as Record<string, unknown>;

  const requiredStrings: Array<keyof CreateShipmentInput> = [
    'customer_name',
    'customer_phone',
    'customer_address',
    'city',
    'district',
  ];

  for (const field of requiredStrings) {
    const value = b[field];
    if (typeof value !== 'string' || value.trim() === '') {
      throw new BadRequestError(`Field "${field}" is required and must be a non-empty string.`);
    }
  }

  // cod_amount: optional, defaults to 0, must be a non-negative number.
  let codAmount = 0;
  if (b.cod_amount !== undefined && b.cod_amount !== null) {
    const parsed = Number(b.cod_amount);
    if (Number.isNaN(parsed) || parsed < 0) {
      throw new BadRequestError('Field "cod_amount" must be a non-negative number.');
    }
    codAmount = parsed;
  }

  return {
    customer_name: (b.customer_name as string).trim(),
    customer_phone: (b.customer_phone as string).trim(),
    customer_address: (b.customer_address as string).trim(),
    city: (b.city as string).trim(),
    district: (b.district as string).trim(),
    cod_amount: codAmount,
  };
}

/**
 * POST /api/shipments
 * Creates a shipment owned by the authenticated merchant (or admin).
 */
export async function createShipment(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    throw new UnauthorizedError('Authentication required.');
  }

  const input = parseCreateInput(req.body);
  const shipment = await shipmentService.createShipment(req.user.id, input);

  res.status(201).json({
    status: 'success',
    message: 'Shipment created.',
    data: shipment,
  });
}

/**
 * GET /api/shipments
 * Lists shipments scoped by role, with pagination for staff.
 */
export async function listShipments(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    throw new UnauthorizedError('Authentication required.');
  }

  const page = Math.max(1, Number(req.query.page) || 1);
  const requestedSize = Number(req.query.pageSize) || DEFAULT_PAGE_SIZE;
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, requestedSize));

  const result = await shipmentService.listShipments(req.user.id, req.user.role, {
    page,
    pageSize,
  });

  res.status(200).json({
    status: 'success',
    ...result,
  });
}

/**
 * GET /api/shipments/:trackingNumber/label
 * Returns structured data for printing a shipping label.
 */
export async function getLabel(req: Request, res: Response): Promise<void> {
  const { trackingNumber } = req.params;

  if (!trackingNumber || trackingNumber.trim() === '') {
    throw new BadRequestError('A tracking number is required.');
  }

  const label = await shipmentService.getLabelData(trackingNumber.trim());

  res.status(200).json({
    status: 'success',
    data: label,
  });
}

const MAX_SCAN_BATCH = 500;

/**
 * Validates and normalizes the scan request body.
 */
function parseScanInput(body: unknown): ScanInput {
  if (typeof body !== 'object' || body === null) {
    throw new BadRequestError('Request body must be a JSON object.');
  }

  const b = body as Record<string, unknown>;

  // trackingNumbers: non-empty array of non-empty strings.
  if (!Array.isArray(b.trackingNumbers) || b.trackingNumbers.length === 0) {
    throw new BadRequestError('"trackingNumbers" must be a non-empty array of strings.');
  }
  if (b.trackingNumbers.length > MAX_SCAN_BATCH) {
    throw new BadRequestError(`A scan batch may contain at most ${MAX_SCAN_BATCH} items.`);
  }

  const trackingNumbers: string[] = [];
  for (const tn of b.trackingNumbers) {
    if (typeof tn !== 'string' || tn.trim() === '') {
      throw new BadRequestError('Every entry in "trackingNumbers" must be a non-empty string.');
    }
    trackingNumbers.push(tn.trim());
  }

  // nextStatus: must be a known shipment status.
  if (typeof b.nextStatus !== 'string' || !SHIPMENT_STATUSES.includes(b.nextStatus as ShipmentStatus)) {
    throw new BadRequestError(
      `"nextStatus" must be one of: ${SHIPMENT_STATUSES.join(', ')}.`
    );
  }

  return {
    trackingNumbers,
    nextStatus: b.nextStatus as ShipmentStatus,
  };
}

/**
 * PATCH /api/shipments/scan
 * Bulk/single barcode scan. Applies an atomic status transition + audit log
 * to each tracking number. Returns per-item results.
 */
export async function scanShipments(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    throw new UnauthorizedError('Authentication required.');
  }

  const { trackingNumbers, nextStatus } = parseScanInput(req.body);

  const results = await shipmentService.processScans(
    trackingNumbers,
    nextStatus,
    req.user.id,
    req.user.role
  );

  const succeeded = results.filter((r) => r.success).length;
  const failed = results.length - succeeded;

  // 207 Multi-Status when the batch is mixed; 200 when everything passed.
  const httpStatus = failed > 0 && succeeded > 0 ? 207 : failed === 0 ? 200 : 422;

  res.status(httpStatus).json({
    status: failed === 0 ? 'success' : 'partial',
    summary: { total: results.length, succeeded, failed },
    results,
  });
}

/**
 * GET /api/shipments/:trackingNumber/history
 * Returns the chronological lifecycle of a package.
 */
export async function getHistory(req: Request, res: Response): Promise<void> {
  const { trackingNumber } = req.params;

  if (!trackingNumber || trackingNumber.trim() === '') {
    throw new BadRequestError('A tracking number is required.');
  }

  const data = await shipmentService.getHistory(trackingNumber.trim());

  res.status(200).json({
    status: 'success',
    data,
  });
}

const MAX_BULK_ASSIGN = 500;

// Basic UUID v4-ish shape check. The database is the final authority;
// this just rejects obviously malformed input early.
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * GET /api/shipments/unassigned
 * Dispatcher view of warehouse packages awaiting a driver, with optional
 * city/district filtering, pagination, and neighborhood groupings.
 */
export async function getUnassigned(req: Request, res: Response): Promise<void> {
  const page = Math.max(1, Number(req.query.page) || 1);
  const requestedSize = Number(req.query.pageSize) || DEFAULT_PAGE_SIZE;
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, requestedSize));

  const city = typeof req.query.city === 'string' && req.query.city.trim() !== ''
    ? req.query.city.trim()
    : undefined;
  const district =
    typeof req.query.district === 'string' && req.query.district.trim() !== ''
      ? req.query.district.trim()
      : undefined;

  const result = await shipmentService.getUnassignedShipments({
    city,
    district,
    page,
    pageSize,
  });

  res.status(200).json({
    status: 'success',
    ...result,
  });
}

/**
 * Validates and normalizes the bulk-assign request body.
 */
function parseBulkAssignInput(body: unknown): BulkAssignInput {
  if (typeof body !== 'object' || body === null) {
    throw new BadRequestError('Request body must be a JSON object.');
  }

  const b = body as Record<string, unknown>;

  if (!Array.isArray(b.shipmentIds) || b.shipmentIds.length === 0) {
    throw new BadRequestError('"shipmentIds" must be a non-empty array of UUIDs.');
  }
  if (b.shipmentIds.length > MAX_BULK_ASSIGN) {
    throw new BadRequestError(`A bulk assignment may contain at most ${MAX_BULK_ASSIGN} shipments.`);
  }

  const shipmentIds: string[] = [];
  for (const id of b.shipmentIds) {
    if (typeof id !== 'string' || !UUID_REGEX.test(id)) {
      throw new BadRequestError(`Invalid shipment ID: ${String(id)}.`);
    }
    shipmentIds.push(id);
  }

  // Reject duplicates so the audit log can't double-count a package.
  const unique = new Set(shipmentIds);
  if (unique.size !== shipmentIds.length) {
    throw new BadRequestError('"shipmentIds" contains duplicate values.');
  }

  if (typeof b.driverId !== 'string' || !UUID_REGEX.test(b.driverId)) {
    throw new BadRequestError('"driverId" must be a valid UUID.');
  }

  return { shipmentIds, driverId: b.driverId };
}

/**
 * POST /api/shipments/bulk-assign
 * Atomically assigns a driver to a batch of shipments and dispatches them.
 */
export async function bulkAssign(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    throw new UnauthorizedError('Authentication required.');
  }

  const { shipmentIds, driverId } = parseBulkAssignInput(req.body);

  const result = await shipmentService.bulkAssignDriver(
    shipmentIds,
    driverId,
    req.user.id
  );

  res.status(200).json({
    status: 'success',
    message: `Dispatched ${result.assigned_count} shipment(s) to driver ${result.driver_id}.`,
    data: result,
  });
}

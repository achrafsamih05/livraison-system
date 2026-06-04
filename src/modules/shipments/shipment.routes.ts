import { Router } from 'express';
import { requireAuth } from '../../shared/middlewares/authMiddleware';
import { restrictTo } from '../../shared/middlewares/roleMiddleware';
import { asyncHandler } from '../../shared/utils/asyncHandler';
import {
  createShipment,
  listShipments,
  getLabel,
  scanShipments,
  getHistory,
  getUnassigned,
  bulkAssign,
} from './shipment.controller';

const router = Router();

// All shipment routes require authentication.
router.use(requireAuth);

// POST /api/shipments — ADMIN or MERCHANT create a shipment.
router.post('/', restrictTo('ADMIN', 'MERCHANT'), asyncHandler(createShipment));

// GET /api/shipments — list shipments (scoped by role inside the service).
router.get('/', restrictTo('ADMIN', 'WAREHOUSE_AGENT', 'MERCHANT'), asyncHandler(listShipments));

// GET /api/shipments/unassigned — dispatcher view of packages awaiting a driver.
// Declared before param routes so "unassigned" isn't captured as a tracking number.
router.get(
  '/unassigned',
  restrictTo('ADMIN', 'WAREHOUSE_AGENT'),
  asyncHandler(getUnassigned)
);

// POST /api/shipments/bulk-assign — atomic batch driver assignment + dispatch.
router.post(
  '/bulk-assign',
  restrictTo('ADMIN', 'WAREHOUSE_AGENT'),
  asyncHandler(bulkAssign)
);

// PATCH /api/shipments/scan — bulk/single barcode scan (workers only).
// Declared before the param routes so "scan" isn't captured as a tracking number.
router.patch('/scan', restrictTo('ADMIN', 'WAREHOUSE_AGENT', 'DRIVER'), asyncHandler(scanShipments));

// GET /api/shipments/:trackingNumber/history — package lifecycle.
router.get(
  '/:trackingNumber/history',
  restrictTo('ADMIN', 'WAREHOUSE_AGENT', 'MERCHANT', 'DRIVER'),
  asyncHandler(getHistory)
);

// GET /api/shipments/:trackingNumber/label — label data for printing.
router.get(
  '/:trackingNumber/label',
  restrictTo('ADMIN', 'WAREHOUSE_AGENT', 'MERCHANT'),
  asyncHandler(getLabel)
);

export default router;

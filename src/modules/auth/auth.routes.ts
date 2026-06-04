import { Router } from 'express';
import { requireAuth } from '../../shared/middlewares/authMiddleware';
import { restrictTo } from '../../shared/middlewares/roleMiddleware';
import { adminOnly, warehouseOnly, getProfile } from './auth.controller';

const router = Router();

// GET /api/auth/profile — any authenticated user.
router.get('/profile', requireAuth, getProfile);

// GET /api/auth/admin-only — ADMIN only.
router.get('/admin-only', requireAuth, restrictTo('ADMIN'), adminOnly);

// GET /api/auth/warehouse-only — ADMIN or WAREHOUSE_AGENT.
router.get(
  '/warehouse-only',
  requireAuth,
  restrictTo('ADMIN', 'WAREHOUSE_AGENT'),
  warehouseOnly
);

export default router;

import { Router } from 'express';
import { requireAuth } from '../../shared/middlewares/authMiddleware';
import { restrictTo } from '../../shared/middlewares/roleMiddleware';
import { asyncHandler } from '../../shared/utils/asyncHandler';
import { getWallet, reconcile, getMerchantBalance, merchantPayout } from './finance.controller';

const router = Router();

// All finance routes require authentication.
router.use(requireAuth);

// GET /api/finance/wallet/:driverId — ADMIN (any) or DRIVER (own only).
// The own-only check for drivers is enforced in the controller.
router.get(
  '/wallet/:driverId',
  restrictTo('ADMIN', 'DRIVER'),
  asyncHandler(getWallet)
);

// GET /api/finance/merchant-balance/:merchantId — ADMIN (any) or MERCHANT (own only).
router.get(
  '/merchant-balance/:merchantId',
  restrictTo('ADMIN', 'MERCHANT'),
  asyncHandler(getMerchantBalance)
);

// POST /api/finance/reconcile — ADMIN only (internal accounting).
router.post('/reconcile', restrictTo('ADMIN'), asyncHandler(reconcile));

// POST /api/finance/merchant-payout — ADMIN only (process merchant payouts).
router.post('/merchant-payout', restrictTo('ADMIN'), asyncHandler(merchantPayout));

export default router;

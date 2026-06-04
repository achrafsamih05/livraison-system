import { Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { financeService } from './finance.service';
import {
  BadRequestError,
  ForbiddenError,
  UnauthorizedError,
} from '../../shared/errors/AppError';
import { PAYOUT_METHODS, PayoutMethod } from './finance.types';

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * GET /api/finance/wallet/:driverId
 * Returns the exact cash currently held by a driver plus a breakdown.
 *
 * Authorization: ADMIN may view any wallet; a DRIVER may view only their own.
 */
export async function getWallet(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    throw new UnauthorizedError('Authentication required.');
  }

  const { driverId } = req.params;
  if (!driverId || !UUID_REGEX.test(driverId)) {
    throw new BadRequestError('A valid driver ID is required.');
  }

  // Drivers are restricted to their own wallet.
  if (req.user.role === 'DRIVER' && req.user.id !== driverId) {
    throw new ForbiddenError('Drivers may only view their own wallet.');
  }

  const wallet = await financeService.getDriverWallet(driverId);

  res.status(200).json({
    status: 'success',
    data: wallet,
  });
}

/**
 * POST /api/finance/reconcile
 * ADMIN-only. Settles all cash currently held by the given driver.
 */
export async function reconcile(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    throw new UnauthorizedError('Authentication required.');
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const driverId = body.driverId;

  if (typeof driverId !== 'string' || !UUID_REGEX.test(driverId)) {
    throw new BadRequestError('"driverId" must be a valid UUID.');
  }

  // Confirm the target is actually a driver before settling cash.
  await financeService.assertIsDriver(driverId);

  const result = await financeService.reconcileDriver(driverId, req.user.id);

  res.status(200).json({
    status: 'success',
    message: `Reconciled ${result.settled_count} transaction(s); total ${result.total_settled} settled with company.`,
    data: result,
  });
}

/**
 * GET /api/finance/merchant-balance/:merchantId
 * Returns a merchant's pending (held) and available (settled) balances.
 *
 * Authorization: ADMIN may view any merchant; a MERCHANT may view only own.
 */
export async function getMerchantBalance(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    throw new UnauthorizedError('Authentication required.');
  }

  const { merchantId } = req.params;
  if (!merchantId || !UUID_REGEX.test(merchantId)) {
    throw new BadRequestError('A valid merchant ID is required.');
  }

  // Merchants are restricted to their own balance.
  if (req.user.role === 'MERCHANT' && req.user.id !== merchantId) {
    throw new ForbiddenError('Merchants may only view their own balance.');
  }

  const balance = await financeService.getMerchantBalance(merchantId);

  res.status(200).json({
    status: 'success',
    data: balance,
  });
}

/**
 * POST /api/finance/merchant-payout
 * ADMIN-only. Pays out all funds settled with the company for a merchant.
 */
export async function merchantPayout(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    throw new UnauthorizedError('Authentication required.');
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const merchantId = body.merchantId;
  const payoutMethod = body.payoutMethod;

  if (typeof merchantId !== 'string' || !UUID_REGEX.test(merchantId)) {
    throw new BadRequestError('"merchantId" must be a valid UUID.');
  }
  if (
    typeof payoutMethod !== 'string' ||
    !PAYOUT_METHODS.includes(payoutMethod as PayoutMethod)
  ) {
    throw new BadRequestError(
      `"payoutMethod" must be one of: ${PAYOUT_METHODS.join(', ')}.`
    );
  }

  // Confirm the target is actually a merchant before moving money.
  await financeService.assertHasRole(merchantId, 'MERCHANT');

  // Accept a client-supplied reference, otherwise generate a traceable one.
  const payoutReference =
    typeof body.payoutReference === 'string' && body.payoutReference.trim() !== ''
      ? body.payoutReference.trim()
      : `PO-${randomUUID()}`;

  const result = await financeService.processMerchantPayout(
    merchantId,
    req.user.id,
    payoutMethod as PayoutMethod,
    payoutReference
  );

  res.status(200).json({
    status: 'success',
    message: `Paid out ${result.total_paid} to merchant ${merchantId} via ${result.payout_method}.`,
    data: result,
  });
}

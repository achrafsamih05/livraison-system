import { supabaseAdmin } from '../../config/supabase';
import { AppError, BadRequestError } from '../../shared/errors/AppError';
import {
  WalletSummary,
  WalletLineItem,
  ReconcileResult,
  MerchantBalance,
  PayoutResult,
  PayoutMethod,
} from './finance.types';

export class FinanceService {
  /**
   * Computes a driver's wallet: the exact total of cash currently held
   * (status = HELD_BY_DRIVER) plus a per-shipment breakdown.
   *
   * The total is summed in SQL (driver_wallet_total RPC) over numeric(10,2)
   * and returned as a string. We deliberately do NOT sum in JavaScript to
   * avoid floating-point rounding on monetary values.
   */
  async getDriverWallet(driverId: string): Promise<WalletSummary> {
    // 1. Exact total + count from the database.
    const { data: totalData, error: totalError } = await supabaseAdmin.rpc(
      'driver_wallet_total',
      { p_driver_id: driverId }
    );

    if (totalError) {
      throw new AppError(`Failed to compute wallet total: ${totalError.message}`, 500);
    }

    const total = totalData as { held_count: number; total_held: string };

    // 2. Line-item breakdown, joined to the shipment for the tracking number.
    const { data: rows, error: rowsError } = await supabaseAdmin
      .from('financial_transactions')
      .select(
        `
        id,
        shipment_id,
        amount_collected,
        delivery_fee,
        merchant_share,
        shipment:shipment_id ( tracking_number )
        `
      )
      .eq('driver_id', driverId)
      .eq('status', 'HELD_BY_DRIVER')
      .order('created_at', { ascending: true });

    if (rowsError) {
      throw new AppError(`Failed to fetch wallet breakdown: ${rowsError.message}`, 500);
    }

    const items: WalletLineItem[] = (
      (rows ?? []) as unknown as Array<{
        id: string;
        shipment_id: string;
        amount_collected: string;
        delivery_fee: string;
        merchant_share: string;
        shipment: { tracking_number: string } | { tracking_number: string }[] | null;
      }>
    ).map((r) => {
      // Supabase may type an embedded one-to-one join as an array; normalize.
      const shipment = Array.isArray(r.shipment) ? r.shipment[0] : r.shipment;
      return {
        transaction_id: r.id,
        shipment_id: r.shipment_id,
        tracking_number: shipment?.tracking_number ?? 'UNKNOWN',
        amount_collected: r.amount_collected,
        delivery_fee: r.delivery_fee,
        merchant_share: r.merchant_share,
      };
    });

    return {
      driver_id: driverId,
      held_count: total.held_count,
      total_held: total.total_held,
      items,
    };
  }

  /**
   * Atomically reconciles a driver's held cash: every HELD_BY_DRIVER row
   * becomes SETTLED_WITH_COMPANY, stamped with the clearing admin's ID.
   * The whole batch is processed inside the reconcile_driver_cash function
   * (single transaction), so it either fully succeeds or fully rolls back.
   */
  async reconcileDriver(driverId: string, adminId: string): Promise<ReconcileResult> {
    const { data, error } = await supabaseAdmin.rpc('reconcile_driver_cash', {
      p_driver_id: driverId,
      p_admin_id: adminId,
    });

    if (error) {
      throw new AppError(`Reconciliation failed: ${error.message}`, 500);
    }

    return data as ReconcileResult;
  }

  /**
   * Verifies a user exists and has the expected role. Used to validate the
   * target of wallet / reconciliation / payout operations.
   */
  async assertHasRole(userId: string, expectedRole: string): Promise<void> {
    const { data, error } = await supabaseAdmin
      .from('profiles')
      .select('role')
      .eq('id', userId)
      .maybeSingle();

    if (error) {
      throw new AppError(`Failed to verify user: ${error.message}`, 500);
    }
    if (!data) {
      throw new AppError(`User ${userId} does not exist.`, 404);
    }
    if ((data as { role: string }).role !== expectedRole) {
      throw new AppError(`User ${userId} is not a ${expectedRole}.`, 400);
    }
  }

  /** Convenience wrapper retained for the driver wallet/reconcile paths. */
  async assertIsDriver(driverId: string): Promise<void> {
    return this.assertHasRole(driverId, 'DRIVER');
  }

  /**
   * Returns a merchant's cleared-balance metrics: pending_clearance (still
   * held by drivers) and available_for_payout (settled with the company).
   * Both sums are computed exactly in SQL and returned as decimal strings.
   */
  async getMerchantBalance(merchantId: string): Promise<MerchantBalance> {
    const { data, error } = await supabaseAdmin.rpc('merchant_cleared_balance', {
      p_merchant_id: merchantId,
    });

    if (error) {
      throw new AppError(`Failed to compute merchant balance: ${error.message}`, 500);
    }

    const b = data as {
      pending_clearance: string;
      pending_count: number;
      available_for_payout: string;
      available_count: number;
    };

    return {
      merchant_id: merchantId,
      pending_clearance: b.pending_clearance,
      pending_count: b.pending_count,
      available_for_payout: b.available_for_payout,
      available_count: b.available_count,
    };
  }

  /**
   * Atomically pays out all SETTLED_WITH_COMPANY transactions for a merchant,
   * flipping them to PAID_TO_MERCHANT and stamping the processing admin,
   * method, and reference. The whole batch commits or rolls back together.
   *
   * If no funds are available, the database function raises P0001, which we
   * translate into a clean 400 BadRequestError.
   */
  async processMerchantPayout(
    merchantId: string,
    adminId: string,
    payoutMethod: PayoutMethod,
    payoutReference: string
  ): Promise<PayoutResult> {
    const { data, error } = await supabaseAdmin.rpc('process_merchant_payout', {
      p_merchant_id: merchantId,
      p_admin_id: adminId,
      p_payout_method: payoutMethod,
      p_payout_reference: payoutReference,
    });

    if (error) {
      // P0001 is our explicit "no funds available" signal from the function.
      if (error.code === 'P0001' || /No funds available/i.test(error.message)) {
        throw new BadRequestError(
          `No funds available for payout for merchant ${merchantId}.`
        );
      }
      throw new AppError(`Merchant payout failed: ${error.message}`, 500);
    }

    return data as PayoutResult;
  }
}

export const financeService = new FinanceService();

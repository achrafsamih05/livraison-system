/**
 * Financial transaction statuses. Mirrors the CHECK constraint on
 * financial_transactions.status in migration 0006.
 */
export const TRANSACTION_STATUSES = [
  'HELD_BY_DRIVER',
  'SETTLED_WITH_COMPANY',
  'PAID_TO_MERCHANT',
] as const;

export type TransactionStatus = (typeof TRANSACTION_STATUSES)[number];

/**
 * A financial_transactions row.
 *
 * NOTE: monetary fields are typed as `string`, not `number`. Supabase
 * returns numeric(10,2) columns as strings to preserve exact decimal
 * precision. We never coerce these to JS floats — all arithmetic is done
 * in SQL. Treat them as opaque, exact decimal strings.
 */
export interface FinancialTransaction {
  id: string;
  shipment_id: string;
  driver_id: string;
  merchant_id: string;
  amount_collected: string;
  delivery_fee: string;
  merchant_share: string;
  status: TransactionStatus;
  reconciled_by: string | null;
  created_at: string;
}

/**
 * A single line item in a driver's wallet breakdown.
 */
export interface WalletLineItem {
  transaction_id: string;
  shipment_id: string;
  tracking_number: string;
  amount_collected: string;
  delivery_fee: string;
  merchant_share: string;
}

/**
 * Driver wallet summary: exact total held plus the underlying line items.
 */
export interface WalletSummary {
  driver_id: string;
  held_count: number;
  total_held: string; // exact decimal string, summed in SQL
  items: WalletLineItem[];
}

/**
 * Result of an atomic reconciliation.
 */
export interface ReconcileResult {
  success: boolean;
  settled_count: number;
  total_settled: string;
  reconciled_by?: string;
  transaction_ids?: string[];
  message?: string;
}

/**
 * Merchant cleared-balance metrics. Amounts are exact decimal strings.
 */
export interface MerchantBalance {
  merchant_id: string;
  pending_clearance: string; // sum of merchant_share where HELD_BY_DRIVER
  pending_count: number;
  available_for_payout: string; // sum of merchant_share where SETTLED_WITH_COMPANY
  available_count: number;
}

/**
 * Accepted payout methods. Mirrors the CHECK constraint in migration 0008.
 */
export const PAYOUT_METHODS = ['BANK_TRANSFER', 'CASH'] as const;
export type PayoutMethod = (typeof PAYOUT_METHODS)[number];

/**
 * Result of an atomic merchant payout.
 */
export interface PayoutResult {
  success: boolean;
  paid_count: number;
  total_paid: string;
  merchant_id: string;
  paid_by: string;
  payout_method: PayoutMethod;
  payout_reference: string;
  paid_at: string;
  transaction_ids: string[];
}

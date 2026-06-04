/**
 * Application user roles. Mirrors the `user_role` enum defined in the
 * database migration (0001_initial_schema.sql). Keep these in sync.
 */
export const USER_ROLES = ['ADMIN', 'MERCHANT', 'WAREHOUSE_AGENT', 'DRIVER'] as const;

export type UserRole = (typeof USER_ROLES)[number];

/**
 * Runtime type guard to validate a raw string (e.g. coming from the
 * database) is a known role before we trust it.
 */
export function isUserRole(value: unknown): value is UserRole {
  return typeof value === 'string' && (USER_ROLES as readonly string[]).includes(value);
}

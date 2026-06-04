import { randomInt } from 'crypto';

/**
 * Alphabet for the random portion of a tracking number.
 * Ambiguous characters (0/O, 1/I, etc.) are intentionally excluded so the
 * code stays human-readable when printed on a label or read over the phone.
 */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const RANDOM_LENGTH = 6;
const PREFIX = 'FX';

/**
 * Generates the random alphanumeric segment using a cryptographically
 * secure source (crypto.randomInt) rather than Math.random.
 */
function randomSegment(length = RANDOM_LENGTH): string {
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += ALPHABET[randomInt(0, ALPHABET.length)];
  }
  return out;
}

/**
 * Builds a single candidate tracking number, e.g. "FX-2026-X7R9W2".
 * Collision checking against the database is the caller's responsibility
 * (see ShipmentService.generateUniqueTrackingNumber).
 */
export function buildTrackingNumber(date: Date = new Date()): string {
  const year = date.getFullYear();
  return `${PREFIX}-${year}-${randomSegment()}`;
}

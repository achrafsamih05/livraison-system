import { Request, Response, NextFunction } from 'express';
import { ForbiddenError, UnauthorizedError } from '../errors/AppError';
import { UserRole } from '../types/roles';

/**
 * restrictTo(...allowedRoles)
 * ---------------------------
 * Returns a middleware that allows the request through only if the
 * authenticated user's role is in the allowed list. Otherwise it blocks
 * with a 403 Forbidden.
 *
 * MUST be mounted AFTER `requireAuth`, since it relies on `req.user`.
 *
 * Usage:
 *   router.get('/admin', requireAuth, restrictTo('ADMIN'), handler);
 */
export function restrictTo(...allowedRoles: UserRole[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    // Defensive guard: if requireAuth wasn't run first, fail closed.
    if (!req.user) {
      return next(
        new UnauthorizedError('Authentication required before authorization.')
      );
    }

    if (!allowedRoles.includes(req.user.role)) {
      return next(
        new ForbiddenError(
          `Access denied. Required role(s): ${allowedRoles.join(', ')}.`
        )
      );
    }

    next();
  };
}

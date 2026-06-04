import { Request, Response, NextFunction } from 'express';
import { AppError } from '../errors/AppError';
import { isProduction } from '../../config/env';

/**
 * Centralized error-handling middleware.
 *
 * Express identifies error handlers by their four-argument signature, so
 * `next` must remain in the signature even though it is unused.
 */
export function errorHandler(
  err: Error,
  _req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _next: NextFunction
): void {
  const isAppError = err instanceof AppError;
  const statusCode = isAppError ? err.statusCode : 500;

  // Log unexpected (non-operational) errors with their stack for debugging.
  if (!isAppError || statusCode >= 500) {
    console.error('[ERROR]', err);
  }

  res.status(statusCode).json({
    status: 'error',
    statusCode,
    message: isAppError ? err.message : 'Internal server error',
    // Only expose stack traces outside of production.
    ...(isProduction ? {} : { stack: err.stack }),
  });
}

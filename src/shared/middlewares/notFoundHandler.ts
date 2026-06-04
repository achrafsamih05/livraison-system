import { Request, Response, NextFunction } from 'express';
import { NotFoundError } from '../errors/AppError';

/**
 * Catch-all middleware for unmatched routes. Forwards a 404 AppError
 * to the centralized error handler.
 */
export function notFoundHandler(
  req: Request,
  _res: Response,
  next: NextFunction
): void {
  next(new NotFoundError(`Route not found: ${req.method} ${req.originalUrl}`));
}

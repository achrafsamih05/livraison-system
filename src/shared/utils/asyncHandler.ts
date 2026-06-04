import { Request, Response, NextFunction, RequestHandler } from 'express';

/**
 * Wraps an async route handler so any rejected promise is automatically
 * forwarded to Express's error-handling middleware. This avoids repetitive
 * try/catch blocks in every controller.
 *
 * Usage:
 *   router.get('/', asyncHandler(async (req, res) => { ... }));
 */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>
): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

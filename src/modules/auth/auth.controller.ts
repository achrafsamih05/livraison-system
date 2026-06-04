import { Request, Response } from 'express';

/**
 * Returns the currently authenticated user's data (populated by requireAuth).
 * Accessible to any authenticated user.
 */
export function getProfile(req: Request, res: Response): void {
  res.status(200).json({
    status: 'success',
    message: 'Authenticated profile retrieved.',
    user: req.user,
  });
}

/**
 * Demo endpoint reachable only by ADMIN.
 */
export function adminOnly(req: Request, res: Response): void {
  res.status(200).json({
    status: 'success',
    message: 'Welcome, ADMIN. You have access to this restricted resource.',
    user: req.user,
  });
}

/**
 * Demo endpoint reachable by ADMIN and WAREHOUSE_AGENT.
 */
export function warehouseOnly(req: Request, res: Response): void {
  res.status(200).json({
    status: 'success',
    message: 'Warehouse area access granted.',
    user: req.user,
  });
}

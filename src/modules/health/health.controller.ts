import { Request, Response } from 'express';
import { env } from '../../config/env';
import { supabaseAdmin } from '../../config/supabase';

/**
 * Health-check controller. Returns liveness information and verifies live
 * connectivity to Supabase by issuing a lightweight, read-only probe query.
 *
 * Returns 200 when the API and its database channel are both healthy, and
 * 503 (Service Unavailable) when the Supabase connection cannot be reached —
 * so load balancers and uptime monitors can react correctly.
 */
export async function getHealth(_req: Request, res: Response): Promise<void> {
  const startedAt = Date.now();
  let dbStatus: 'up' | 'down' = 'down';
  let dbError: string | null = null;

  try {
    // Lightweight connectivity probe: ask for zero rows, just the count head.
    const { error } = await supabaseAdmin
      .from('profiles')
      .select('id', { count: 'exact', head: true });

    if (error) {
      dbError = error.message;
    } else {
      dbStatus = 'up';
    }
  } catch (err) {
    dbError = err instanceof Error ? err.message : 'Unknown database error';
  }

  const healthy = dbStatus === 'up';

  res.status(healthy ? 200 : 503).json({
    status: healthy ? 'ok' : 'degraded',
    service: 'logistics-platform-api',
    environment: env.nodeEnv,
    uptime: process.uptime(),
    dependencies: {
      supabase: {
        status: dbStatus,
        latencyMs: Date.now() - startedAt,
        ...(dbError ? { error: dbError } : {}),
      },
    },
    timestamp: new Date().toISOString(),
  });
}

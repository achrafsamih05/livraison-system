import express, { Application } from 'express';
import cors from 'cors';

import healthRoutes from './modules/health/health.routes';
import authRoutes from './modules/auth/auth.routes';
import shipmentRoutes from './modules/shipments/shipment.routes';
import financeRoutes from './modules/finance/finance.routes';
import { notFoundHandler } from './shared/middlewares/notFoundHandler';
import { errorHandler } from './shared/middlewares/errorHandler';

/**
 * Builds and configures the Express application.
 *
 * Order matters:
 *   1. Global middleware (CORS, body parsing)
 *   2. Feature routes
 *   3. 404 handler (after all known routes)
 *   4. Centralized error handler (must be last)
 */
function createApp(): Application {
  const app = express();

  // --- Global middleware ---
  app.use(cors());
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // --- Routes ---
  app.get('/', (_req, res) => {
    res.status(200).json({
      service: 'logistics-platform-api',
      message: 'Welcome to the Logistics Platform API',
      docs: '/health to verify server status',
    });
  });

  app.use('/health', healthRoutes);
  app.use('/api/auth', authRoutes);
  app.use('/api/shipments', shipmentRoutes);
  app.use('/api/finance', financeRoutes);

  // --- Error handling ---
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

export default createApp;

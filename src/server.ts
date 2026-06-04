import createApp from './app';
import { env } from './config/env';

/**
 * Application entry point.
 *
 * Initializing `env` (imported transitively) validates that all required
 * environment variables are present before the server starts listening.
 */
function startServer(): void {
  const app = createApp();

  const server = app.listen(env.port, () => {
    console.log('=================================================');
    console.log(`  Logistics Platform API`);
    console.log(`  Environment : ${env.nodeEnv}`);
    console.log(`  Listening   : http://localhost:${env.port}`);
    console.log(`  Health check: http://localhost:${env.port}/health`);
    console.log('=================================================');
  });

  // Deterministic port allocation: fail loudly with a clear message and a
  // non-zero exit code if the configured port is already in use, instead of
  // crashing with a raw stack trace.
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(
        `[FATAL] Port ${env.port} is already in use. ` +
          `Free the port or set a different PORT in your .env, then restart.`
      );
      process.exit(1);
    }
    console.error('[FATAL] Server failed to start:', err);
    process.exit(1);
  });

  // Graceful shutdown on termination signals.
  const shutdown = (signal: string): void => {
    console.log(`\n${signal} received. Shutting down gracefully...`);
    server.close(() => {
      console.log('Server closed. Bye.');
      process.exit(0);
    });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Surface unexpected failures instead of leaving the process in a bad state.
  process.on('unhandledRejection', (reason) => {
    console.error('[UNHANDLED REJECTION]', reason);
  });
}

startServer();

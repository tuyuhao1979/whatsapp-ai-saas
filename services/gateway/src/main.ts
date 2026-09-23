import { loadConfig } from './config.js';
import { buildApp } from './server.js';

async function start(): Promise<void> {
  const config = loadConfig();
  const app = await buildApp(config);

  try {
    await app.listen({ port: config.PORT, host: '0.0.0.0' });
  } catch (err) {
    app.log.fatal({ err }, 'Server failed to start');
    process.exit(1);
  }
}

start().catch((err: unknown) => {
  // Startup failed before (or while constructing) the Fastify instance, so
  // there is no logger to use yet — write straight to stderr.
  // eslint-disable-next-line no-console
  console.error('Unhandled startup error:', err);
  process.exit(1);
});

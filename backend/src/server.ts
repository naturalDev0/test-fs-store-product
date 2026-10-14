import { createApp } from './app.js';
import { config } from './config.js';
import { pool } from './db.js';

const server = createApp().listen(config.port, () => {
  console.log(`API listening on http://localhost:${config.port}`);
});

// Finish in-flight requests and close DB connections on shutdown.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close(() => {
      pool.end().finally(() => process.exit(0));
    });
  });
}

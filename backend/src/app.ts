import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { config } from './config.js';
import { pool } from './db.js';
import { authRouter } from './routes/auth.js';
import { storefrontRouter } from './routes/storefront.js';
import { adminRouter } from './routes/admin.js';
import { errorHandler, notFoundHandler } from './middleware/errors.js';

export function createApp() {
  const app = express();

  app.use(helmet());
  app.use(cors({ origin: config.corsOrigin }));
  app.use(express.json({ limit: '100kb' }));

  app.get('/api/health', async (_req, res) => {
    await pool.query('SELECT 1');
    res.json({ status: 'ok' });
  });

  app.use('/api/auth', authRouter);
  app.use('/api/admin', adminRouter);
  app.use('/api', storefrontRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

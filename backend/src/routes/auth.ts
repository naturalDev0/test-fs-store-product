import { Router } from 'express';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import { pool } from '../db.js';
import { config } from '../config.js';
import { HttpError, PG, pgCode } from '../errors.js';
import { signToken, type Role } from '../auth/tokens.js';
import { requireAuth } from '../middleware/auth.js';
import { credentials } from './schemas.js';

export const authRouter = Router();

// Slow down password guessing. Disabled in tests, which log in many times.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  skip: () => config.isTest,
});

// Compared against when the email doesn't exist, so a login for an unknown
// email takes as long as one with a wrong password (no account enumeration).
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);

/** Self-registration always creates a customer. Admins are created by seeding. */
authRouter.post('/register', authLimiter, async (req, res) => {
  const { email, password } = credentials.parse(req.body);
  const hash = await bcrypt.hash(password, 10);
  try {
    const { rows } = await pool.query<{ id: number; email: string; role: Role }>(
      `INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id, email, role`,
      [email, hash],
    );
    const user = rows[0];
    res.status(201).json({ token: signToken(user.id, user.role), user });
  } catch (err) {
    if (pgCode(err) === PG.UNIQUE_VIOLATION) {
      throw new HttpError(409, 'EMAIL_TAKEN', 'An account with this email already exists');
    }
    throw err;
  }
});

authRouter.post('/login', authLimiter, async (req, res) => {
  const { email, password } = credentials.parse(req.body);
  const { rows } = await pool.query<{ id: number; email: string; role: Role; password_hash: string }>(
    'SELECT id, email, role, password_hash FROM users WHERE lower(email) = lower($1)',
    [email],
  );
  const user = rows[0];
  const ok = await bcrypt.compare(password, user?.password_hash ?? DUMMY_HASH);
  if (!user || !ok) {
    throw new HttpError(401, 'INVALID_CREDENTIALS', 'Incorrect email or password');
  }
  res.json({
    token: signToken(user.id, user.role),
    user: { id: user.id, email: user.email, role: user.role },
  });
});

authRouter.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

import type { NextFunction, Request, Response } from 'express';
import { pool } from '../db.js';
import { HttpError } from '../errors.js';
import { verifyToken, type Role } from '../auth/tokens.js';

export interface AuthUser {
  id: number;
  email: string;
  role: Role;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

/**
 * Requires a valid Bearer token.
 *
 * The role is re-read from the database on every request rather than trusted
 * from the token, so demoting or deleting a user takes effect immediately
 * instead of when their token expires. Cost: one indexed primary-key lookup.
 */
export async function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    throw new HttpError(401, 'UNAUTHENTICATED', 'Missing bearer token');
  }

  let userId: number;
  try {
    userId = verifyToken(header.slice('Bearer '.length)).sub;
  } catch {
    throw new HttpError(401, 'UNAUTHENTICATED', 'Invalid or expired token');
  }

  const { rows } = await pool.query<AuthUser>(
    'SELECT id, email, role FROM users WHERE id = $1',
    [userId],
  );
  if (!rows[0]) throw new HttpError(401, 'UNAUTHENTICATED', 'User no longer exists');

  req.user = rows[0];
  next();
}

/** Must run after requireAuth. */
export function requireRole(...roles: Role[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user || !roles.includes(req.user.role)) {
      throw new HttpError(403, 'FORBIDDEN', 'You do not have permission to do this');
    }
    next();
  };
}

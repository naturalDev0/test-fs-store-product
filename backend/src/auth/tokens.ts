import jwt, { type SignOptions } from 'jsonwebtoken';
import { config } from '../config.js';

export type Role = 'admin' | 'customer';

export interface TokenPayload {
  sub: number;
  role: Role;
}

export function signToken(userId: number, role: Role): string {
  return jwt.sign({ role }, config.jwtSecret, {
    subject: String(userId),
    expiresIn: config.jwtExpiresIn as SignOptions['expiresIn'],
    algorithm: 'HS256',
  });
}

export function verifyToken(token: string): TokenPayload {
  // Pin the algorithm so a forged token can't downgrade to "none".
  const decoded = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] });
  if (typeof decoded === 'string' || !decoded.sub) throw new Error('Malformed token');
  return { sub: Number(decoded.sub), role: decoded.role as Role };
}

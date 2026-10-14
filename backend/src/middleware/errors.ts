import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { HttpError, PG, pgCode } from '../errors.js';

export function notFoundHandler(_req: Request, _res: Response, next: NextFunction) {
  next(new HttpError(404, 'NOT_FOUND', 'Route not found'));
}

// Express recognises error handlers by their four-argument signature.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof HttpError) {
    return res.status(err.status).json({
      error: { code: err.code, message: err.message, details: err.details },
    });
  }

  if (err instanceof ZodError) {
    return res.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Request validation failed',
        details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      },
    });
  }

  // Malformed JSON body.
  if (err instanceof SyntaxError && 'body' in err) {
    return res.status(400).json({ error: { code: 'INVALID_JSON', message: 'Malformed JSON body' } });
  }

  // A database constraint caught something validation missed.
  if (pgCode(err) === PG.CHECK_VIOLATION) {
    return res
      .status(409)
      .json({ error: { code: 'CONSTRAINT_VIOLATION', message: 'The change would leave invalid data' } });
  }

  console.error(err);
  return res.status(500).json({ error: { code: 'INTERNAL', message: 'Something went wrong' } });
}

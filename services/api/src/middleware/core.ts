import type { ErrorRequestHandler, RequestHandler } from 'express';
import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import { AppError, Errors } from '../lib/errors';

export const correlation: RequestHandler = (req, res, next) => {
  const incoming = req.get('x-correlation-id');
  req.correlationId = incoming && /^[\w-]{8,64}$/.test(incoming) ? incoming : randomUUID();
  res.setHeader('x-correlation-id', req.correlationId);
  next();
};

export const notFound: RequestHandler = (_req, _res, next) => next(Errors.notFound('Endpoint'));

/** Spec §8.3 error envelope. Unknown errors are logged and returned as a generic 500. */
export function errorHandler(log: Logger): ErrorRequestHandler {
  return (err, req, res, _next) => {
    let e: AppError;
    if (err instanceof AppError) e = err;
    else if (err?.type === 'entity.parse.failed') e = Errors.validation([{ message: 'Body is not valid JSON' }]);
    else if (err?.type === 'entity.too.large') e = new AppError(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large');
    else {
      log.error({ err, correlationId: req.correlationId }, 'unhandled error');
      e = new AppError(500, 'INTERNAL', 'Something went wrong on our side. Quote the correlation id if you contact support.');
    }
    res.status(e.status).json({ error: { code: e.code, message: e.message, correlationId: req.correlationId, details: e.details, ...e.extra } });
  };
}

// core/error-handler.js — typed application errors and the central error
// middleware. Every error leaving the API passes through here so responses
// are consistent, secrets are never leaked and server stacks stay in logs.
export class AppError extends Error {
  constructor(status, code, message, details = undefined) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.expose = status < 500;
  }
}

export const badRequest = (msg, details) => new AppError(400, 'BAD_REQUEST', msg || 'Bad request', details);
export const unauthorized = (msg) => new AppError(401, 'UNAUTHORIZED', msg || 'Authentication required');
export const forbidden = (msg) => new AppError(403, 'FORBIDDEN', msg || 'Permission denied');
export const notFound = (msg) => new AppError(404, 'NOT_FOUND', msg || 'Not found');
export const conflict = (msg) => new AppError(409, 'CONFLICT', msg || 'Conflict');
export const gone = (msg) => new AppError(410, 'GONE', msg || 'Resource no longer available');
export const payloadTooLarge = (msg) => new AppError(413, 'PAYLOAD_TOO_LARGE', msg || 'Request body too large');
export const unsupportedMedia = (msg) => new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', msg || 'Unsupported media type');
export const tooManyRequests = (msg, retryAfter) => {
  const e = new AppError(429, 'RATE_LIMITED', msg || 'Too many requests');
  e.retryAfter = retryAfter;
  return e;
};
export const unprocessable = (msg, details) => new AppError(422, 'UNPROCESSABLE', msg || 'Unprocessable entity', details);
export const internal = (msg) => new AppError(500, 'INTERNAL', msg || 'Internal server error');
export const notImplemented = (msg) => new AppError(501, 'NOT_IMPLEMENTED', msg || 'Not implemented in this deployment — see documentation for required setup');
export const serviceUnavailable = (msg) => new AppError(503, 'SERVICE_UNAVAILABLE', msg || 'Service unavailable');

export function isAppError(err) {
  return err instanceof AppError;
}

export function normalizeError(err) {
  if (isAppError(err)) return err;
  if (err && (err.status || err.statusCode) && err.code) {
    const e = new AppError(err.status || err.statusCode, err.code, err.message || 'Error', err.details);
    return e;
  }
  // SQLite / driver level errors get wrapped so we never leak raw stack details.
  const e = new AppError(500, 'INTERNAL', err?.message || 'Internal server error');
  e.cause = err;
  return e;
}

export function serializeError(err) {
  const e = normalizeError(err);
  const body = {
    error: {
      code: e.code,
      message: e.expose ? e.message : 'Internal server error',
    },
  };
  if (e.details && e.expose) body.error.details = e.details;
  if (e.retryAfter) body.error.retryAfter = e.retryAfter;
  return body;
}

// Wraps an async route handler so rejections reach the error middleware.
export function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

export function errorMiddleware(logger) {
  return (err, req, res) => {
    const e = normalizeError(err);
    const requestId = req.requestId || '-';
    const logPayload = {
      requestId,
      method: req.method,
      path: req.url,
      status: e.status,
      code: e.code,
      message: e.message,
    };
    if (e.status >= 500) {
      logPayload.stack = e.stack || (e.cause && e.cause.stack);
      logger.error?.('unhandled request error', logPayload);
    } else {
      logger.debug?.('request error', logPayload);
    }
    if (res.headersSent) {
      try { res.end(); } catch { /* socket already gone */ }
      return;
    }
    const body = JSON.stringify(serializeError(e));
    res.writeHead(e.status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      'X-Request-Id': requestId,
    });
    res.end(body);
  };
}

export function notFoundMiddleware(logger) {
  return (req, res) => {
    const e = notFound(`No route matches ${req.method} ${req.path || req.url}`);
    return errorMiddleware(logger)(e, req, res);
  };
}

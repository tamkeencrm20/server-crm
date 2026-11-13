/** An error the API is willing to describe to the client. */
export class AppError extends Error {
  /**
   * @param {number} status HTTP status code
   * @param {string} message safe, user-facing message
   * @param {object} [options]
   * @param {string} [options.code] stable machine-readable code for the frontend
   * @param {unknown} [options.details] extra context (validation issues, etc.)
   */
  constructor(status, message, { code, details } = {}) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code ?? httpCode(status);
    this.details = details;
    this.expected = true;
  }
}

function httpCode(status) {
  return (
    {
      400: 'BAD_REQUEST',
      401: 'UNAUTHORIZED',
      403: 'FORBIDDEN',
      404: 'NOT_FOUND',
      409: 'CONFLICT',
      422: 'UNPROCESSABLE',
      429: 'RATE_LIMITED',
    }[status] ?? 'INTERNAL_ERROR'
  );
}

export const badRequest = (m, o) => new AppError(400, m, o);
export const unauthorized = (m = 'Authentication required', o) => new AppError(401, m, o);
export const forbidden = (m = 'You do not have access to this resource', o) => new AppError(403, m, o);
export const notFound = (m = 'Resource not found', o) => new AppError(404, m, o);
export const conflict = (m, o) => new AppError(409, m, o);

/** Wrap an async express handler so rejections reach the error middleware. */
export const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

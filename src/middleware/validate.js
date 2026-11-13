import { ZodError } from 'zod';
import { badRequest } from '../utils/errors.js';

/**
 * Validates and REPLACES the given request part with the parsed result, so
 * handlers work with coerced, stripped data rather than raw user input.
 *
 * @param {import('zod').ZodTypeAny} schema
 * @param {'body'|'query'|'params'} where
 */
export function validate(schema, where = 'body') {
  return (req, _res, next) => {
    try {
      const parsed = schema.parse(req[where]);
      if (where === 'query') {
        // Express 4 exposes req.query via a getter on some setups; assigning
        // to a private field keeps handlers reading a stable, parsed object.
        req.validatedQuery = parsed;
      } else {
        req[where] = parsed;
      }
      next();
    } catch (err) {
      if (err instanceof ZodError) {
        return next(
          badRequest('Validation failed', {
            code: 'VALIDATION_ERROR',
            details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
          }),
        );
      }
      next(err);
    }
  };
}

/** Handlers read query params through this, whether validated or not. */
export const q = (req) => req.validatedQuery ?? req.query;

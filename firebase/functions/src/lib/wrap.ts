/**
 * Callable wrapper: turns a thrown ValidationError (lib/money.ts) into an
 * HttpsError('invalid-argument') so every callable reports Flask-style messages
 * consistently. HttpsError and everything else pass through untouched.
 */
import { HttpsError, CallableRequest } from "firebase-functions/v2/https";
import { ValidationError } from "./money";

export function callable<T, R>(
  handler: (req: CallableRequest<T>) => Promise<R>,
): (req: CallableRequest<T>) => Promise<R> {
  return async (req) => {
    try {
      return await handler(req);
    } catch (e) {
      if (e instanceof ValidationError) {
        throw new HttpsError("invalid-argument", e.message);
      }
      throw e;
    }
  };
}

/**
 * "Callable" dispatch convention for API Gateway routes shaped
 * `/api/callable/{module}/{action}` (see aws/infra/lib/api-stack.ts). Each
 * module Lambda (billing.ts, staffAdmin.ts, ...) exports one `handler` built
 * with `dispatch({ actionName: fn, ... })`; `fn` receives the parsed JSON
 * body and the raw event, and returns a plain object (200) or throws
 * (ValidationError -> 422, HttpError -> its status, anything else -> 500,
 * logged server-side, generic message to the client — never leak internals).
 *
 * This is the direct replacement for Firebase's `onCall` + `CallableRequest`:
 * same "one module, several named operations, one error envelope" shape the
 * existing Firestore callables already used, so porting each handler body is
 * a mechanical find/replace rather than a redesign.
 */
import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from "aws-lambda";
import { ValidationError } from "./money";
import { HttpError } from "./authz";
import { ok, err } from "./http";

export type ActionHandler = (body: any, event: APIGatewayProxyEventV2WithJWTAuthorizer) => Promise<unknown>;

export function dispatch(actions: Record<string, ActionHandler>) {
  return async (event: APIGatewayProxyEventV2WithJWTAuthorizer): Promise<APIGatewayProxyResultV2> => {
    try {
      const action = event.pathParameters?.action || "";
      const fn = actions[action];
      if (!fn) return err(`unknown action "${action}"`, 404, "not-found");
      let body: any = {};
      if (event.body) {
        try {
          body = JSON.parse(event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body);
        } catch {
          return err("request body must be valid JSON", 400, "invalid-argument");
        }
      }
      const result = await fn(body, event);
      return ok(result);
    } catch (e) {
      if (e instanceof ValidationError) return err(e.message, 422, "invalid-argument");
      if (e instanceof HttpError) return err(e.message, e.statusCode, e.code);
      // eslint-disable-next-line no-console
      console.error("callable handler error", e);
      return err("Something went wrong. Please try again.", 500, "internal");
    }
  };
}

/**
 * Lambda handler wrapper — API Gateway HTTP API port of
 * firebase/functions/src/lib/wrap.ts. Turns a thrown ValidationError/HttpError
 * into the right status code + a stable `{ error: { code, message } }` body,
 * matching the shape the frontend's api-shim.js already expects (it was built
 * against Firebase HttpsError codes; kept identical so hosting/js/*.js needs
 * no rewrite of its error handling, only of its transport — see websiteApi
 * handler for the callable-style envelope).
 */
import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from "aws-lambda";
import { ValidationError } from "./money";
import { HttpError } from "./authz";

export function json(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

export function ok(data: unknown, statusCode = 200): APIGatewayProxyResultV2 {
  return json(statusCode, data);
}

export function err(message: string, statusCode = 400, code = "invalid-argument"): APIGatewayProxyResultV2 {
  return json(statusCode, { error: { code, message } });
}

type Handler = (event: APIGatewayProxyEventV2WithJWTAuthorizer) => Promise<APIGatewayProxyResultV2>;

export function withErrors(handler: Handler): Handler {
  return async (event) => {
    try {
      return await handler(event);
    } catch (e) {
      if (e instanceof ValidationError) return err(e.message, 422, "invalid-argument");
      if (e instanceof HttpError) return err(e.message, e.statusCode, e.code);
      // eslint-disable-next-line no-console
      console.error("handler error", e);
      return err("Something went wrong. Please try again.", 500, "internal");
    }
  };
}

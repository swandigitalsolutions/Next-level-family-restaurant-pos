/*
 * aws-config.js — API endpoint config for the POS staff app. AWS analogue of
 * firebase/hosting/js/firebase-config.js. An API Gateway HTTP API endpoint
 * and WebSocket endpoint are NOT secrets (protected by Cognito auth + IAM,
 * not by obscurity) — committing them is standard practice, same reasoning
 * as the Firebase Web API key.
 *
 * REQUIRES REAL PRODUCTION CONFIGURATION: fill these in with the CDK stack
 * outputs after `cdk deploy` (ApiEndpoint from ApiStack, WebSocketEndpoint
 * from RealtimeStack) — see aws/docs/DEPLOY.md. Local dev talks to
 * `http://localhost:3000` (a `sam local start-api` / lightweight local
 * gateway — see aws/docs/DEPLOY.md "local run" section) unless overridden.
 */
export const awsConfig = (typeof window !== "undefined" && window.__AWS_CONFIG__) || {
  apiBaseUrl: "REPLACE_WITH_API_GATEWAY_ENDPOINT", // e.g. https://abc123.execute-api.ap-south-1.amazonaws.com
  wsBaseUrl: "REPLACE_WITH_WEBSOCKET_ENDPOINT", // e.g. wss://xyz456.execute-api.ap-south-1.amazonaws.com/prod
};

export const USE_LOCAL_API =
  typeof location !== "undefined" &&
  /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);

export const API_BASE_URL = USE_LOCAL_API ? "http://localhost:3000" : awsConfig.apiBaseUrl;
export const WS_BASE_URL = USE_LOCAL_API ? "ws://localhost:3001" : awsConfig.wsBaseUrl;

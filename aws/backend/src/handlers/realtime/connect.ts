/**
 * $connect — API Gateway WebSocket route. The client connects to
 *   wss://.../<stage>?token=<Cognito ID token>&channel=kitchen|live_orders|website_orders
 * (see aws/hosting/js/aws-realtime.js). The token is verified here (there is
 * no separate WebSocket authorizer construct — verifying inline keeps the
 * realtime stack simple and puts the same role check every REST callable
 * uses in one place: `channel=kitchen` requires KITCHEN_ROLES, etc. — the
 * exact "Kitchen never sees unrelated boards" guarantee the Firestore rules
 * gave, reproduced here since WebSocket connections have no per-message auth).
 *
 * On success the connection is recorded in `ws_connections`; the client then
 * receives a backlog replay (any tickets/orders updated after `?since=`) so
 * a reconnect never misses an event — the AWS analogue of the
 * `metadata.fromCache` + `kf_kds_seen_ms` dedup already implemented
 * client-side.
 */
import type { APIGatewayProxyWebsocketHandlerV2 } from "aws-lambda";
import { CognitoJwtVerifier } from "aws-jwt-verify";
import { getPool } from "../../lib/db";
import { normalizeRole, KITCHEN_ROLES, BILLING_ROLES } from "../../lib/config";

const ALLOWED_CHANNELS = ["kitchen", "live_orders", "website_orders"] as const;
type Channel = (typeof ALLOWED_CHANNELS)[number];

function rolesFor(channel: Channel): readonly string[] {
  if (channel === "kitchen") return KITCHEN_ROLES;
  return BILLING_ROLES; // live_orders (QR board) + website_orders board are both Billing-surface
}

let verifier: ReturnType<typeof CognitoJwtVerifier.create> | undefined;
function getVerifier() {
  if (!verifier) {
    verifier = CognitoJwtVerifier.create({
      userPoolId: process.env.COGNITO_USER_POOL_ID!,
      tokenUse: "id",
      clientId: process.env.COGNITO_CLIENT_ID!,
    });
  }
  return verifier;
}

export const handler: APIGatewayProxyWebsocketHandlerV2 = async (event) => {
  try {
    const qs = event.queryStringParameters || {};
    const token = qs.token;
    const channel = qs.channel as Channel | undefined;
    if (!token || !channel || !ALLOWED_CHANNELS.includes(channel)) {
      return { statusCode: 400, body: "missing or invalid token/channel" };
    }
    const claims = await getVerifier().verify(token).catch(() => null);
    if (!claims) return { statusCode: 401, body: "invalid token" };

    const role = normalizeRole((claims as any)["custom:role"]);
    if (!rolesFor(channel).includes(role)) {
      return { statusCode: 403, body: "role not permitted on this channel" };
    }
    const uid = (claims as any)["custom:pos_uid"] || claims.sub;

    const pool = await getPool();
    await pool.query(
      "INSERT INTO ws_connections (connection_id, uid, role, channel, connected_at) VALUES ($1,$2,$3,$4,now())",
      [event.requestContext.connectionId, uid, role, channel],
    );
    return { statusCode: 200, body: "connected" };
  } catch (e) {
    console.error("$connect failed", e);
    return { statusCode: 500, body: "internal error" };
  }
};

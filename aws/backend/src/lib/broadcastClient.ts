/**
 * Fan a realtime event out to every WebSocket connection subscribed to a
 * channel ("kitchen" | "live_orders" | "website_orders") — the direct
 * replacement for Firestore onSnapshot pushing document changes to
 * listening clients. Called by the write-path handlers (kitchen.ts,
 * qrOrdersAdmin.ts, websiteOrdersAdmin.ts) after their transaction commits.
 *
 * Looks up subscribed connections in `ws_connections`, posts to each via
 * ApiGatewayManagementApi, and prunes any connection that reports GONE
 * (410) — the same cleanup API Gateway's own $disconnect route does for a
 * clean close, this catches the ones that dropped without one.
 */
import { ApiGatewayManagementApiClient, PostToConnectionCommand, GoneException } from "@aws-sdk/client-apigatewaymanagementapi";
import { getPool } from "./db";

let client: ApiGatewayManagementApiClient | undefined;
function getClient(): ApiGatewayManagementApiClient | null {
  const endpoint = process.env.WS_API_ENDPOINT;
  if (!endpoint) return null; // not configured (e.g. local/offline testing) — broadcast becomes a no-op
  return (client ??= new ApiGatewayManagementApiClient({ endpoint }));
}

export async function broadcast(channel: "kitchen" | "live_orders" | "website_orders", payload: unknown): Promise<void> {
  const cli = getClient();
  if (!cli) return; // never throws in an environment with no WebSocket API deployed yet
  const pool = await getPool();
  const res = await pool.query("SELECT connection_id FROM ws_connections WHERE channel = $1", [channel]);
  const data = Buffer.from(JSON.stringify(payload));
  await Promise.all(res.rows.map(async (row) => {
    try {
      await cli.send(new PostToConnectionCommand({ ConnectionId: row.connection_id, Data: data }));
    } catch (e) {
      if (e instanceof GoneException) {
        await pool.query("DELETE FROM ws_connections WHERE connection_id = $1", [row.connection_id]).catch(() => undefined);
      } else {
        console.error("broadcast: post to connection failed (non-fatal)", row.connection_id, e);
      }
    }
  }));
}

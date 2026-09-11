/** $disconnect — remove the closed connection from the registry. Best-effort:
 * a failed delete here just means broadcast() prunes it lazily on the next
 * GoneException, so this handler never needs to fail the disconnect. */
import type { APIGatewayProxyWebsocketHandlerV2 } from "aws-lambda";
import { getPool } from "../../lib/db";

export const handler: APIGatewayProxyWebsocketHandlerV2 = async (event) => {
  try {
    const pool = await getPool();
    await pool.query("DELETE FROM ws_connections WHERE connection_id = $1", [event.requestContext.connectionId]);
  } catch (e) {
    console.error("$disconnect cleanup failed (non-fatal)", e);
  }
  return { statusCode: 200, body: "disconnected" };
};

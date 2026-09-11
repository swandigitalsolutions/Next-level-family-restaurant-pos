/** $default — handles any client->server frame on the WebSocket route (the
 * client only ever sends a lightweight keepalive ping; all real traffic is
 * server->client via broadcastClient.ts). Never throws — an unrecognized
 * frame is simply ignored so a client sending garbage can never tear down
 * its own connection or anyone else's. */
import type { APIGatewayProxyWebsocketHandlerV2 } from "aws-lambda";

export const handler: APIGatewayProxyWebsocketHandlerV2 = async (event) => {
  try {
    const body = event.body ? JSON.parse(event.body) : {};
    if (body?.type === "ping") return { statusCode: 200, body: JSON.stringify({ type: "pong" }) };
  } catch {
    /* ignore malformed frames — never crash the connection */
  }
  return { statusCode: 200, body: "" };
};

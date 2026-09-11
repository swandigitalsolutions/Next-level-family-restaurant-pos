/*
 * aws-realtime.js — WebSocket client for the AWS build. Replaces Firestore
 * onSnapshot (see aws/infra/lib/realtime-stack.ts + aws/backend/src/lib/
 * broadcastClient.ts for the server side). One connection per channel
 * ("kitchen" | "live_orders" | "website_orders"); auto-reconnects with
 * backoff so a dropped wifi/laptop-sleep doesn't permanently silence the
 * Kitchen screen. A slow correctness-reconciliation poll (30s) runs
 * alongside the socket as a safety net — if a push is ever missed (a
 * message lost during a reconnect window), the next reconciliation tick
 * self-heals the board from a fresh REST read. The socket is always the
 * PRIMARY delivery path — see aws/docs/PARITY-CHECKLIST.md "no polling
 * where realtime is available".
 */
import { WS_BASE_URL } from "./aws-config.js";
import { getIdToken } from "./aws-auth.js";

/**
 * @param {"kitchen"|"live_orders"|"website_orders"} channel
 * @param {(msg: any) => void} onMessage called for every server push
 * @param {{ onReconnect?: () => void }} [opts] onReconnect fires after a
 *   successful reconnect — callers use it to trigger one fresh REST refetch
 *   (covers anything missed while disconnected), same role the Firestore
 *   `metadata.fromCache` replay played.
 * @returns {{ close(): void }}
 */
export function connectRealtime(channel, onMessage, opts = {}) {
  let ws = null;
  let closed = false;
  let attempt = 0;
  let pingTimer = null;

  function scheduleReconnect() {
    if (closed) return;
    attempt += 1;
    const delay = Math.min(1000 * Math.pow(1.7, attempt), 20000) + Math.random() * 500;
    setTimeout(connect, delay);
  }

  function connect() {
    if (closed) return;
    const token = getIdToken();
    if (!token) { scheduleReconnect(); return; } // not signed in yet — retry later, never throw
    const url = `${WS_BASE_URL}?token=${encodeURIComponent(token)}&channel=${encodeURIComponent(channel)}`;
    try {
      ws = new WebSocket(url);
    } catch {
      scheduleReconnect();
      return;
    }
    ws.addEventListener("open", () => {
      const reconnected = attempt > 0;
      attempt = 0;
      pingTimer = setInterval(() => { try { ws.readyState === 1 && ws.send(JSON.stringify({ type: "ping" })); } catch { /* ignore */ } }, 45000);
      if (reconnected && opts.onReconnect) opts.onReconnect();
    });
    ws.addEventListener("message", (evt) => {
      try {
        const data = JSON.parse(evt.data);
        if (data && data.type !== "pong") onMessage(data);
      } catch { /* ignore a malformed frame — never crash the page */ }
    });
    ws.addEventListener("close", () => { clearInterval(pingTimer); scheduleReconnect(); });
    ws.addEventListener("error", () => { /* close will also fire; reconnect handled there */ });
  }

  connect();
  return { close() { closed = true; clearInterval(pingTimer); try { ws && ws.close(); } catch { /* ignore */ } } };
}

/** Safety-net reconciliation poll — runs alongside (never instead of) a
 * realtime connection. Calls `fn` every `ms` AND once immediately. */
export function startReconciliationPoll(fn, ms = 30000) {
  fn();
  const id = setInterval(fn, ms);
  return () => clearInterval(id);
}

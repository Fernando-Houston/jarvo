import { config } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
// Load the repo-root .env (hvi/.env) regardless of where the gateway is run from,
// then allow a local apps/gateway/.env to override.
const here = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.resolve(here, "../../../.env") });
config();

import { WebSocketServer } from "ws";
import { Session } from "./session";
import { crmAvailable } from "./tools/crm";

const PORT = Number(process.env.GATEWAY_PORT || 8787);

const wss = new WebSocketServer({ port: PORT });

wss.on("connection", (ws, req) => {
  const url = new URL(req.url ?? "/", "ws://localhost");
  // Shared-secret auth (team use behind HTTPS). Unset = open, for local dev.
  const secret = process.env.HVI_SHARED_SECRET;
  if (secret && url.searchParams.get("token") !== secret) {
    ws.close(4401, "unauthorized");
    return;
  }
  // The team-room feed is a Workers/DO feature; in local dev, hold the
  // socket open as a silent sink so the client doesn't reconnect-loop —
  // but don't spin up a phantom voice Session for it.
  if (url.pathname === "/room") {
    ws.on("error", () => undefined);
    return;
  }
  const session = new Session(ws, { user: url.searchParams.get("u") });
  ws.on("message", (data, isBinary) => {
    if (isBinary) session.handleAudio(data as Buffer);
    else session.handleText(data.toString());
  });
  ws.on("close", () => session.destroy());
  ws.on("error", () => session.destroy());
});

const caps = {
  stt: process.env.DEEPGRAM_API_KEY ? "deepgram" : "client (Web Speech API)",
  tts: process.env.ELEVENLABS_API_KEY ? "elevenlabs" : "client (speechSynthesis)",
  brain: process.env.ANTHROPIC_API_KEY ? "claude" : "rules (keyless demo)",
  crm: crmAvailable() ? "connected" : "off",
};
console.log(`[hvi-gateway] ws://localhost:${PORT}`);
console.log(`[hvi-gateway] capabilities:`, caps);

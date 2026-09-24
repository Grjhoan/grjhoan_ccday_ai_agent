import express from "express";
import { env } from "./config.js";
import { shouldHandle } from "./filter.js";
import { handleIncoming } from "./handler.js";
import { TtlMap } from "./memory.js";

const seen = new TtlMap<true>(60 * 60 * 1000);
// Serialize work per conversation so two quick messages don't race.
const queues = new Map<number, Promise<void>>();

export const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req, res) => {
  res.type("text").send("ok");
});

app.post("/chatwoot/webhook", (req, res) => {
  if (!env.webhookSecret || req.query.secret !== env.webhookSecret) {
    res.status(401).send("unauthorized");
    return;
  }
  res.status(200).send("ok");

  const msg = shouldHandle(req.body);
  if ("ignore" in msg) {
    console.log(`[webhook] ignored (${msg.ignore})`);
    return;
  }
  if (seen.has(msg.messageId)) {
    console.log(`[webhook] duplicate message ${msg.messageId}`);
    return;
  }
  seen.set(msg.messageId, true);
  console.log(`[webhook] conv=${msg.conversationId} msg=${msg.messageId} "${msg.content}"`);

  const prev = queues.get(msg.conversationId) ?? Promise.resolve();
  const next = prev.then(() => handleIncoming(msg));
  queues.set(msg.conversationId, next);
  next.finally(() => {
    if (queues.get(msg.conversationId) === next) queues.delete(msg.conversationId);
  });
});

if (process.env.NODE_ENV !== "test") {
  app.listen(env.port, () => console.log(`silbato-support-agent on :${env.port} (model=${env.model}, dryRun=${env.dryRun})`));
}

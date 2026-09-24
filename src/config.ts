import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
export const path = (...p: string[]) => resolve(root, ...p);
export const readText = (...p: string[]) => readFileSync(path(...p), "utf8");
export const readJson = <T>(...p: string[]): T => JSON.parse(readText(...p));

export const env = {
  port: Number(process.env.PORT ?? 3000),
  model: process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5",
  effort: (process.env.ANTHROPIC_EFFORT ?? "medium") as "low" | "medium" | "high" | "xhigh" | "max",
  chatwootUrl: (process.env.CHATWOOT_URL ?? "").replace(/\/+$/, ""),
  botToken: process.env.CHATWOOT_BOT_TOKEN ?? "",
  userToken: process.env.CHATWOOT_USER_TOKEN || undefined,
  webhookSecret: process.env.WEBHOOK_SECRET ?? "",
  dryRun: process.env.DRY_RUN === "true",
};

import type Anthropic from "@anthropic-ai/sdk";
import { runAgent } from "./agent.js";
import { chatwoot, ChatwootError, type ChatwootMessage } from "./chatwoot.js";
import { env } from "./config.js";
import { normalize, wantsHuman, type IncomingMessage } from "./filter.js";
import { TtlMap } from "./memory.js";
import { handoff, type ToolContext } from "./tools.js";

const MAX_BOT_MESSAGES = 8;
const FALLBACK_MESSAGE = "Lo siento, tuve un problema procesando tu mensaje.";

// Fallback history when the bot token can't read messages from Chatwoot
// (Chatwoot returns 401 "not authorized for bots" on the messages list endpoint).
type Turn = { role: "user" | "assistant"; text: string };
let historyForbidden = false;
const localHistory = new TtlMap<Turn[]>(6 * 60 * 60 * 1000);

async function loadHistory(msg: IncomingMessage): Promise<Turn[]> {
  let remote: ChatwootMessage[] = [];
  if (!env.dryRun && !historyForbidden) {
    try {
      remote = await chatwoot.getMessages(msg.accountId, msg.conversationId);
    } catch (err) {
      if (err instanceof ChatwootError && err.status === 401) historyForbidden = true;
      console.warn("history from Chatwoot failed, using memory from now on:", (err as Error).message);
    }
  }
  let turns: Turn[];
  if (remote.length) {
    turns = remote
      .filter((m) => !m.private && m.content && [0, 1, "incoming", "outgoing"].includes(m.message_type))
      .sort((a, b) => a.created_at - b.created_at || a.id - b.id)
      .map((m) => ({ role: m.message_type === 0 || m.message_type === "incoming" ? "user" : "assistant", text: m.content! }));
  } else {
    turns = [...(localHistory.get(msg.conversationId) ?? [])];
  }
  // Make sure the current message is last (webhook can arrive before the list API reflects it).
  const last = turns.at(-1);
  if (!last || last.role !== "user" || last.text !== msg.content) turns.push({ role: "user", text: msg.content });
  return turns;
}

/** Merge consecutive same-role turns and drop leading assistant turns (API needs user first). */
function toMessages(turns: Turn[]): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = [];
  for (const t of turns) {
    const prev = out.at(-1);
    if (prev && prev.role === t.role) prev.content = `${prev.content}\n${t.text}`;
    else if (out.length || t.role === "user") out.push({ role: t.role, content: t.text });
  }
  return out;
}

export async function handleIncoming(msg: IncomingMessage): Promise<void> {
  const ctx: ToolContext = {
    accountId: msg.accountId,
    conversationId: msg.conversationId,
    labels: [...msg.labels],
    contactEmail: msg.contactEmail,
    handedOff: false,
    resolveAfterReply: false,
  };
  const { accountId: a, conversationId: c } = msg;

  try {
    // Fast path: explicit request for a human, no LLM call needed.
    if (wantsHuman(msg.content)) {
      await handoff(ctx, "El cliente pidió hablar con una persona", `Último mensaje: "${msg.content}"`);
      return;
    }

    const turns = await loadHistory(msg);
    const userTexts = turns.filter((t) => t.role === "user").map((t) => normalize(t.text));
    const current = normalize(msg.content);
    if (current.length > 5 && userTexts.slice(0, -1).includes(current)) {
      await handoff(ctx, "El cliente repitió la misma pregunta", `Mensaje repetido: "${msg.content}"`);
      return;
    }
    if (turns.filter((t) => t.role === "assistant").length >= MAX_BOT_MESSAGES) {
      await handoff(ctx, `Más de ${MAX_BOT_MESSAGES} mensajes del bot sin resolver`, `Último mensaje: "${msg.content}"`);
      return;
    }

    const history = toMessages(turns);
    const { reply } = await runAgent(history, ctx);
    if (ctx.handedOff) return;
    if (!reply) throw new Error("empty reply from model");

    const sent = await chatwoot.sendMessage(a, c, reply);
    console.log(`[reply] conv=${c} message_id=${sent?.id} "${reply.slice(0, 80)}"`);
    localHistory.set(c, [...turns, { role: "assistant", text: reply }]);
    if (ctx.resolveAfterReply) await chatwoot.toggleStatus(a, c, "resolved");
  } catch (err) {
    console.error(`conversation ${c} failed:`, err);
    if (!ctx.handedOff) {
      await chatwoot.sendMessage(a, c, FALLBACK_MESSAGE).catch(() => {});
      await handoff(ctx, "Error técnico del bot", `Error: ${(err as Error).message}. Último mensaje: "${msg.content}"`).catch(
        (e) => console.error("handoff failed:", e),
      );
    }
  }
}

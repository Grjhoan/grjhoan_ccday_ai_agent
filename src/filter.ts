import { z } from "zod";

export const WebhookPayload = z
  .object({
    event: z.string(),
    id: z.unknown(),
    content: z.string().nullish(),
    message_type: z.union([z.string(), z.number()]).optional(),
    private: z.boolean().optional(),
    sender: z
      .object({ name: z.string().nullish(), email: z.string().nullish(), type: z.string().nullish() })
      .passthrough()
      .nullish(),
    conversation: z
      .object({ id: z.number(), status: z.string().optional(), labels: z.array(z.string()).optional() })
      .passthrough()
      .nullish(),
    account: z.object({ id: z.number() }).passthrough().nullish(),
  })
  .passthrough();
export type WebhookPayload = z.infer<typeof WebhookPayload>;

export type IncomingMessage = {
  messageId: number;
  content: string;
  accountId: number;
  conversationId: number;
  labels: string[];
  contactName?: string;
  contactEmail?: string;
};

/** Returns the message to act on, or a reason string to ignore it. */
export function shouldHandle(raw: unknown): IncomingMessage | { ignore: string } {
  const parsed = WebhookPayload.safeParse(raw);
  if (!parsed.success) return { ignore: "invalid_payload" };
  const p = parsed.data;
  if (p.event !== "message_created") return { ignore: `event:${p.event}` };
  if (p.message_type !== "incoming" && p.message_type !== 0) return { ignore: `message_type:${p.message_type}` };
  if (p.private) return { ignore: "private" };
  if (!p.conversation || !p.account || typeof p.id !== "number") return { ignore: "missing_ids" };
  if (p.conversation.status !== "pending") return { ignore: `status:${p.conversation.status}` };
  const content = (p.content ?? "").trim();
  if (!content) return { ignore: "empty_content" };
  return {
    messageId: p.id,
    content,
    accountId: p.account.id,
    conversationId: p.conversation.id,
    labels: p.conversation.labels ?? [],
    contactName: p.sender?.name ?? undefined,
    contactEmail: p.sender?.email?.toLowerCase() || undefined,
  };
}

const HUMAN_KEYWORDS = /\b(agente|humano|humana|asesor|asesora|persona|operador|operadora)s?\b/i;

/** Cheap pre-LLM check: did the customer ask for a human? */
export function wantsHuman(text: string): boolean {
  return HUMAN_KEYWORDS.test(text.normalize("NFD").replace(/[̀-ͯ]/g, ""));
}

export const normalize = (s: string) =>
  s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();

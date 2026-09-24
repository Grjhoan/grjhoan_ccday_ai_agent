import { appendFileSync } from "node:fs";
import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { chatwoot } from "./chatwoot.js";
import { path, readJson } from "./config.js";
import { checkEligibility, loadRules, REFUND_REASONS, type Purchase } from "./refund.js";

export type ToolContext = {
  accountId: number;
  conversationId: number;
  labels: string[];
  contactEmail?: string;
  handedOff: boolean;
  resolveAfterReply: boolean;
};

export const HANDOFF_MESSAGE = "Un agente te atenderá en breve.";

const purchases = () => readJson<Purchase[]>("data", "purchases.json");
const findOrder = (orderId: string) =>
  purchases().find((p) => p.order_id.toUpperCase() === orderId.trim().toUpperCase());

/** Only purchases that belong to the verified Chatwoot contact are visible to the bot. */
function ownedOrder(ctx: ToolContext, orderId: string): Purchase | undefined {
  const p = findOrder(orderId);
  return p && ctx.contactEmail && p.email.toLowerCase() === ctx.contactEmail ? p : undefined;
}

export const toolDefinitions: Anthropic.Tool[] = [
  {
    name: "lookup_customer_purchase",
    description:
      "Busca compras del cliente por email o número de orden (formato SLB-####). Solo devuelve compras cuyo email coincide con el email verificado del contacto en Chatwoot.",
    input_schema: {
      type: "object",
      properties: {
        email: { type: "string", description: "Email del cliente" },
        order_id: { type: "string", description: "Número de orden, ej. SLB-1001" },
      },
    },
  },
  {
    name: "check_refund_eligibility",
    description:
      "Verifica con reglas fijas si una orden es reembolsable. Úsala siempre antes de decidir. Devuelve eligible, not_eligible o needs_human.",
    input_schema: {
      type: "object",
      properties: {
        order_id: { type: "string" },
        reason: {
          type: "string",
          enum: [...REFUND_REASONS],
          description: "duplicate_charge = cobro duplicado; cancellation = cancelación; service_failure = falla del servicio no resuelta; other = otro motivo",
        },
      },
      required: ["order_id", "reason"],
    },
  },
  {
    name: "submit_refund_decision",
    description:
      "Registra la decisión de reembolso para el equipo (nota privada + etiqueta + log). No mueve dinero. La decisión debe coincidir con el resultado de check_refund_eligibility.",
    input_schema: {
      type: "object",
      properties: {
        order_id: { type: "string" },
        decision: { type: "string", enum: ["approved", "denied"] },
        amount: { type: "number", description: "Monto en COP" },
        reason: { type: "string", enum: [...REFUND_REASONS] },
        summary: { type: "string", description: "Resumen breve del caso para el equipo" },
      },
      required: ["order_id", "decision", "amount", "reason", "summary"],
    },
  },
  {
    name: "handoff_to_human",
    description:
      "Transfiere la conversación a un agente humano. Úsala si el cliente lo pide, el caso sale de la política (needs_human), el cliente está molesto, hay amenazas legales, o no puedes resolver.",
    input_schema: {
      type: "object",
      properties: {
        reason: { type: "string" },
        summary: { type: "string", description: "Resumen del caso para el agente" },
      },
      required: ["reason", "summary"],
    },
  },
];

const LookupInput = z.object({ email: z.string().optional(), order_id: z.string().optional() });
const EligibilityInput = z.object({ order_id: z.string(), reason: z.enum(REFUND_REASONS) });
const DecisionInput = z.object({
  order_id: z.string(),
  decision: z.enum(["approved", "denied"]),
  amount: z.number(),
  reason: z.enum(REFUND_REASONS),
  summary: z.string(),
});
const HandoffInput = z.object({ reason: z.string(), summary: z.string() });

export async function handoff(ctx: ToolContext, reason: string, summary: string) {
  if (ctx.handedOff) return;
  ctx.handedOff = true;
  const { accountId: a, conversationId: c } = ctx;
  await chatwoot.privateNote(a, c, `🤖 Bot → humano\nMotivo: ${reason}\nResumen: ${summary}`).catch(logErr);
  await chatwoot.addLabels(a, c, addLabel(ctx, "bot_handoff"));
  await chatwoot.sendMessage(a, c, HANDOFF_MESSAGE).catch(logErr);
  await chatwoot.toggleStatus(a, c, "open");
}

function addLabel(ctx: ToolContext, label: string) {
  if (!ctx.labels.includes(label)) ctx.labels.push(label);
  return ctx.labels;
}

const logErr = (e: Error) => console.error("chatwoot:", e.message);

export async function runTool(name: string, input: unknown, ctx: ToolContext): Promise<unknown> {
  switch (name) {
    case "lookup_customer_purchase": {
      const { email, order_id } = LookupInput.parse(input);
      if (!ctx.contactEmail) return { result: "identity_unverified", note: "El contacto no tiene email verificado en Chatwoot. No reveles datos; transfiere a un humano." };
      if (email && email.trim().toLowerCase() !== ctx.contactEmail) {
        return { result: "identity_mismatch", note: "El email no coincide con el del contacto. No reveles datos de compras; transfiere a un humano." };
      }
      if (order_id) {
        const p = findOrder(order_id);
        if (!p) return { result: "not_found" };
        if (p.email.toLowerCase() !== ctx.contactEmail) {
          return { result: "identity_mismatch", note: "La orden no pertenece al contacto. No reveles datos; transfiere a un humano." };
        }
        return { result: "found", purchases: [p] };
      }
      const list = purchases().filter((p) => p.email.toLowerCase() === ctx.contactEmail);
      return list.length ? { result: "found", purchases: list } : { result: "not_found" };
    }

    case "check_refund_eligibility": {
      const { order_id, reason } = EligibilityInput.parse(input);
      if (!findOrder(order_id)) return checkEligibility(undefined, reason, loadRules());
      const p = ownedOrder(ctx, order_id);
      if (!p) return { result: "needs_human", reason: "identity_not_verified", refundable_amount_cop: 0 };
      return checkEligibility(p, reason, loadRules());
    }

    case "submit_refund_decision": {
      const d = DecisionInput.parse(input);
      const p = ownedOrder(ctx, d.order_id);
      const check = checkEligibility(p, d.reason, loadRules());
      // Guardrail: the recorded decision must match the deterministic rules.
      if (d.decision === "approved" && (check.result !== "eligible" || d.amount !== check.refundable_amount_cop)) {
        return { ok: false, error: `No se puede aprobar: la verificación dio ${check.result} (${check.reason}), monto permitido ${check.refundable_amount_cop}.` };
      }
      if (d.decision === "denied" && check.result !== "not_eligible") {
        return { ok: false, error: `No se puede negar: la verificación dio ${check.result}. Si es needs_human, transfiere a un humano.` };
      }
      const { accountId: a, conversationId: c } = ctx;
      const label = d.decision === "approved" ? "refund_approved" : "refund_denied";
      await chatwoot.privateNote(
        a,
        c,
        `🤖 Decisión de reembolso: ${d.decision.toUpperCase()}\nOrden: ${d.order_id}\nMonto: $${d.amount.toLocaleString("es-CO")} COP\nMotivo: ${d.reason} (${check.reason})\nResumen: ${d.summary}` +
          (d.decision === "approved" ? `\nAcción: ejecutar reembolso al medio de pago original (${p?.payment_method}).` : ""),
      );
      await chatwoot.addLabels(a, c, addLabel(ctx, label));
      appendFileSync(
        path("data", "refund_log.jsonl"),
        JSON.stringify({ at: new Date().toISOString(), conversation_id: c, ...d, check: check.reason }) + "\n",
      );
      if (d.decision === "approved") ctx.resolveAfterReply = true;
      return { ok: true };
    }

    case "handoff_to_human": {
      const { reason, summary } = HandoffInput.parse(input);
      await handoff(ctx, reason, summary);
      return { ok: true, note: "Conversación transferida. El cliente ya recibió el aviso; no escribas nada más." };
    }

    default:
      return { error: `unknown tool ${name}` };
  }
}

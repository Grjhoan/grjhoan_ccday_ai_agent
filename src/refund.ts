import { readJson } from "./config.js";

export type Purchase = {
  order_id: string;
  email: string;
  customer_name: string;
  academy: string;
  product: string;
  description: string;
  amount_cop: number;
  paid_at: string; // YYYY-MM-DD
  payment_method: string;
  status: "paid" | "refunded";
};

export type RefundRules = {
  refund_window_days: number;
  max_auto_approve_cop: number;
  eligible_reasons: string[];
  window_exempt_reasons: string[];
  non_refundable_products: string[];
};

export const REFUND_REASONS = ["duplicate_charge", "cancellation", "service_failure", "other"] as const;
export type RefundReason = (typeof REFUND_REASONS)[number];

export type Eligibility = {
  result: "eligible" | "not_eligible" | "needs_human";
  reason: string;
  refundable_amount_cop: number;
};

const DAY_MS = 24 * 60 * 60 * 1000;

export function loadRules(): RefundRules {
  return readJson<RefundRules>("config", "refund_rules.json");
}

/** Deterministic eligibility check — the LLM never decides this. */
export function checkEligibility(
  purchase: Purchase | undefined,
  reason: RefundReason,
  rules: RefundRules,
  now: Date = new Date(),
): Eligibility {
  const no = (why: string): Eligibility => ({ result: "not_eligible", reason: why, refundable_amount_cop: 0 });
  const human = (why: string): Eligibility => ({ result: "needs_human", reason: why, refundable_amount_cop: 0 });

  if (!purchase) return no("order_not_found");
  if (purchase.status === "refunded") return no("already_refunded");
  if (rules.non_refundable_products.includes(purchase.product)) return no("non_refundable_product");
  if (!rules.eligible_reasons.includes(reason)) return human("reason_not_covered_by_policy");

  const ageDays = Math.floor((now.getTime() - new Date(`${purchase.paid_at}T00:00:00-05:00`).getTime()) / DAY_MS);
  if (ageDays > rules.refund_window_days && !rules.window_exempt_reasons.includes(reason)) {
    return no(`outside_refund_window (${ageDays} days since payment, window is ${rules.refund_window_days})`);
  }
  if (purchase.amount_cop > rules.max_auto_approve_cop) return human("amount_above_auto_approve_limit");

  return { result: "eligible", reason: "meets_policy", refundable_amount_cop: purchase.amount_cop };
}

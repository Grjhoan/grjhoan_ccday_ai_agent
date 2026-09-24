import { describe, expect, it } from "vitest";
import { checkEligibility, type Purchase, type RefundRules } from "../src/refund";
import rules from "../config/refund_rules.json";
import purchases from "../data/purchases.json";

const r = rules as RefundRules;
const byId = (id: string) => (purchases as Purchase[]).find((p) => p.order_id === id)!;
const NOW = new Date("2026-09-23T12:00:00-05:00");

describe("checkEligibility", () => {
  it("approves a cancellation inside the window and under the limit", () => {
    expect(checkEligibility(byId("SLB-1001"), "cancellation", r, NOW)).toEqual({
      result: "eligible",
      reason: "meets_policy",
      refundable_amount_cop: 89000,
    });
  });

  it("sends amounts above the auto-approve limit to a human", () => {
    expect(checkEligibility(byId("SLB-1002"), "cancellation", r, NOW).result).toBe("needs_human");
  });

  it("denies payments outside the refund window", () => {
    const res = checkEligibility(byId("SLB-1003"), "cancellation", r, NOW);
    expect(res.result).toBe("not_eligible");
    expect(res.reason).toMatch(/outside_refund_window/);
  });

  it("allows duplicate charges outside the window (exempt), subject to amount limit", () => {
    const res = checkEligibility(byId("SLB-1003"), "duplicate_charge", r, NOW);
    expect(res.result).not.toBe("not_eligible");
  });

  it("denies already refunded orders", () => {
    expect(checkEligibility(byId("SLB-1004"), "cancellation", r, NOW).reason).toBe("already_refunded");
  });

  it("denies non-refundable products (implementation)", () => {
    expect(checkEligibility(byId("SLB-1005"), "cancellation", r, NOW).reason).toBe("non_refundable_product");
  });

  it("sends reasons not covered by the policy to a human", () => {
    expect(checkEligibility(byId("SLB-1001"), "other", r, NOW).result).toBe("needs_human");
  });

  it("returns not_eligible when the order does not exist", () => {
    expect(checkEligibility(undefined, "cancellation", r, NOW).reason).toBe("order_not_found");
  });

  it("treats the last day of the window as eligible and the next day as not", () => {
    const p = { ...byId("SLB-1001"), paid_at: "2026-08-24" }; // 30 days before NOW
    expect(checkEligibility(p, "cancellation", r, NOW).result).toBe("eligible");
    expect(checkEligibility({ ...p, paid_at: "2026-08-23" }, "cancellation", r, NOW).result).toBe("not_eligible");
  });
});

/**
 * notificationDispatcher.test.ts
 * ------------------------------
 * The subscription filters.
 *
 * A bug here is SILENT: the user simply never hears about a burst, and has no
 * way to distinguish that from "no burst happened". These rules therefore get
 * tested one condition at a time rather than through a happy path.
 *
 * The database-backed half of the dispatcher (idempotency via the UNIQUE
 * index, FOR UPDATE SKIP LOCKED claiming, status transitions) is verified in
 * src/scripts/verify_dispatcher.ts against a real Postgres, because those are
 * exactly the behaviours a mock would fake.
 */

import { describe, expect, it } from "vitest";
import { subscriptionWants, toPriority } from "./notificationPolicy.js";

const SUB = {
  eventTypes: ["GRB", "GW", "FRB", "NU"],
  observatories: [] as string[],
  priorityLevel: "critical_and_high",
  lifecyclePolicy: {
    preliminary: true, initial: true, update: "significant_only",
    confirmed: true, retraction: true,
  } as Record<string, boolean | "significant_only">,
  isActive: true,
};

const EV = (over: Partial<{
  eventType: string; observatory: string; lifecycle: string; isRetraction: boolean;
}> = {}) => ({
  eventType: "GRB", observatory: "Fermi (GBM)", lifecycle: "confirmed",
  isRetraction: false, ...over,
});

describe("priority mapping", () => {
  it.each([["P0", "CRITICAL"], ["P1", "HIGH"], ["P2", "NORMAL"], ["P3", "LOW"]])(
    "%s → %s", (level, expected) => expect(toPriority(level)).toBe(expected),
  );

  it("treats an unrecognised level as LOW rather than throwing", () => {
    expect(toPriority("nonsense")).toBe("LOW");
  });
});

describe("event type filter", () => {
  it("passes a subscribed type", () => {
    expect(subscriptionWants(SUB, EV(), "HIGH").wanted).toBe(true);
  });

  it("filters an unsubscribed type", () => {
    expect(subscriptionWants({ ...SUB, eventTypes: ["GW"] }, EV(), "HIGH").wanted).toBe(false);
  });

  it("treats an empty list as 'all types'", () => {
    expect(subscriptionWants({ ...SUB, eventTypes: [] }, EV(), "HIGH").wanted).toBe(true);
  });
});

describe("observatory filter", () => {
  it("filters an unsubscribed observatory", () => {
    expect(subscriptionWants({ ...SUB, observatories: ["Swift (BAT)"] }, EV(), "HIGH").wanted)
      .toBe(false);
  });

  it("treats an empty list as 'all observatories'", () => {
    expect(subscriptionWants(SUB, EV({ observatory: "SVOM (GRM)" }), "HIGH").wanted).toBe(true);
  });
});

describe("priority threshold", () => {
  it("critical_and_high accepts HIGH but not NORMAL", () => {
    expect(subscriptionWants(SUB, EV(), "HIGH").wanted).toBe(true);
    expect(subscriptionWants(SUB, EV(), "NORMAL").wanted).toBe(false);
  });

  it("critical_only rejects HIGH", () => {
    expect(subscriptionWants({ ...SUB, priorityLevel: "critical_only" }, EV(), "HIGH").wanted)
      .toBe(false);
  });

  it("'all' accepts LOW", () => {
    expect(subscriptionWants({ ...SUB, priorityLevel: "all" }, EV(), "LOW").wanted).toBe(true);
  });

  it("explains why it filtered, for the log", () => {
    const v = subscriptionWants(SUB, EV(), "NORMAL");
    expect(v.reason).toMatch(/priority/i);
  });
});

describe("lifecycle policy", () => {
  it("filters a disabled lifecycle", () => {
    expect(subscriptionWants(
      { ...SUB, lifecyclePolicy: { confirmed: false } }, EV(), "HIGH").wanted).toBe(false);
  });

  it("allows 'significant_only' through — the dedup engine already judged it", () => {
    // Re-deciding significance here would be a second implementation of that
    // rule, free to disagree with the first.
    expect(subscriptionWants(SUB, EV({ lifecycle: "update" }), "HIGH").wanted).toBe(true);
  });

  it("allows a lifecycle the policy does not mention", () => {
    expect(subscriptionWants({ ...SUB, lifecyclePolicy: {} }, EV(), "HIGH").wanted).toBe(true);
  });

  it("tolerates a null policy", () => {
    expect(subscriptionWants({ ...SUB, lifecyclePolicy: null }, EV(), "HIGH").wanted).toBe(true);
  });
});

describe("inactive subscriptions", () => {
  it("never receive anything", () => {
    expect(subscriptionWants({ ...SUB, isActive: false }, EV(), "CRITICAL").wanted).toBe(false);
  });

  it("do not receive retractions either", () => {
    expect(subscriptionWants(
      { ...SUB, isActive: false }, EV({ isRetraction: true }), "CRITICAL").wanted).toBe(false);
  });
});

describe("a retraction overrides every content filter", () => {
  // Someone acting on the original alert — pointing a telescope, filing a
  // circular — must be told it was withdrawn.
  it.each([
    ["unsubscribed event type", { eventTypes: ["GW"] }],
    ["unsubscribed observatory", { observatories: ["Swift (BAT)"] }],
    ["priority below threshold", { priorityLevel: "critical_only" }],
    ["lifecycle disabled", { lifecyclePolicy: { confirmed: false, retraction: false } }],
  ])("reaches a subscriber with %s", (_label, over) => {
    expect(subscriptionWants(
      { ...SUB, ...over } as typeof SUB, EV({ isRetraction: true }), "LOW").wanted).toBe(true);
  });
});

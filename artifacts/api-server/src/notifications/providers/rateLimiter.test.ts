/**
 * rateLimiter.test.ts
 * -------------------
 * The sliding window that keeps a GCN burst from tripping WeCom's 20/minute
 * ceiling and losing the alerts most worth having.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { inspect, resetRateLimiter, tryConsume } from "./rateLimiter.js";

const T0 = 1_000_000;

beforeEach(() => resetRateLimiter());

describe("window accounting", () => {
  it("admits exactly the limit and no more", () => {
    let admitted = 0;
    for (let i = 0; i < 25; i++) if (tryConsume("robot", 20, T0 + i).allowed) admitted++;
    expect(admitted).toBe(20);
  });

  it("reports when a slot frees rather than just refusing", () => {
    for (let i = 0; i < 20; i++) tryConsume("robot", 20, T0 + i);
    const d = tryConsume("robot", 20, T0 + 30);
    expect(d.allowed).toBe(false);
    expect(d.retryAfterMs).toBeGreaterThan(0);
    expect(d.retryAfterMs).toBeLessThanOrEqual(60_000);
  });

  it("slides — capacity returns after the window passes", () => {
    for (let i = 0; i < 20; i++) tryConsume("robot", 20, T0 + i);
    expect(tryConsume("robot", 20, T0 + 30).allowed).toBe(false);
    expect(tryConsume("robot", 20, T0 + 60_001).allowed).toBe(true);
  });

  it("does not permit a double burst across the window boundary", () => {
    // The reason this is a sliding window and not a token bucket: a bucket
    // would allow N at the end of one window and N at the start of the next,
    // i.e. 2N inside any 60 seconds — tripping the very limit it exists to
    // respect.
    for (let i = 0; i < 20; i++) tryConsume("robot", 20, T0 + i);
    let admitted = 0;
    for (let i = 0; i < 20; i++) if (tryConsume("robot", 20, T0 + 30_000 + i).allowed) admitted++;
    expect(admitted).toBe(0);
  });

  it("reports remaining capacity", () => {
    const d = tryConsume("robot", 20, T0);
    expect(d.remaining).toBe(19);
  });
});

describe("scoping", () => {
  it("keeps credentials independent", () => {
    for (let i = 0; i < 20; i++) tryConsume("robotA", 20, T0 + i);
    // One lab exhausting its robot must not consume another lab's allowance.
    expect(tryConsume("robotA", 20, T0 + 30).allowed).toBe(false);
    expect(tryConsume("robotB", 20, T0 + 30).allowed).toBe(true);
  });
});

describe("consume-and-record is atomic", () => {
  it("never admits more than the limit under interleaved calls", () => {
    // A separate check-then-record would let two async slots both observe
    // capacity and both send.
    const results = Array.from({ length: 40 }, (_, i) => tryConsume("robot", 5, T0 + i));
    expect(results.filter((r) => r.allowed)).toHaveLength(5);
  });
});

describe("inspect", () => {
  it("does not mutate the window", () => {
    tryConsume("robot", 20, T0);
    const a = inspect("robot", T0 + 10);
    const b = inspect("robot", T0 + 10);
    expect(a.used).toBe(b.used);
    expect(a.used).toBe(1);
  });

  it("returns zero for an unseen key", () => {
    expect(inspect("never-used").used).toBe(0);
  });
});

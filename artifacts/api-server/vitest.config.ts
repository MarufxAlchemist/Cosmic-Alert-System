import { defineConfig } from "vitest/config";

/**
 * Unit tests only, by design.
 *
 * These run without a database, a broker or a network, so they can execute in
 * CI and on a laptop with no setup. The database-backed checks live in
 * src/scripts/verify_*.ts and are run against a live stack, because what they
 * assert — a UNIQUE index rejecting a duplicate, FOR UPDATE SKIP LOCKED
 * claiming a row once — is precisely the behaviour a mock would fake.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Providers read process.env at call time; isolate so one test's override
    // cannot leak into another's expectations.
    isolate: true,
    restoreMocks: true,
  },
});

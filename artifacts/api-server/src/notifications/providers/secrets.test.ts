/**
 * secrets.test.ts
 * ---------------
 * Encryption at rest and redaction.
 *
 * These are the tests that protect a credential rather than a feature. A
 * regression here does not break a page — it quietly starts writing a bearer
 * token into a log or an API response, which nobody notices until it is
 * already somewhere it should not be.
 */

import { beforeAll, describe, expect, it } from "vitest";
import {
  decryptSecret,
  displayWebhook,
  encryptSecret,
  encryptionAvailable,
  isEncrypted,
  redactSecrets,
  safeEquals,
  SecretConfigurationError,
} from "./secrets.js";

const KEY_HEX = "9f2b7c1e4a8d0356f1b9e7c2a4d68015392b7ce4a1d80f56239b7ce4a1d80f56";
const SECRET = "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=693a91f6-7xxx-4bc4-97a0-0ec2sifa5aaa";

beforeAll(() => {
  process.env["NOTIFICATION_ENCRYPTION_KEY"] = KEY_HEX;
});

describe("encryption", () => {
  it("round-trips", () => {
    expect(decryptSecret(encryptSecret(SECRET))).toBe(SECRET);
  });

  it("does not leave the plaintext in the ciphertext", () => {
    expect(encryptSecret(SECRET)).not.toContain("693a91f6");
  });

  it("is non-deterministic — a fresh IV per call", () => {
    // Deterministic ciphertext would let an observer tell that two labs
    // configured the same robot, and would leak equality across rows.
    expect(encryptSecret(SECRET)).not.toBe(encryptSecret(SECRET));
  });

  it("detects tampering (GCM auth tag)", () => {
    const enc = encryptSecret(SECRET);
    const tampered = enc.slice(0, -4) + "AAAA";
    expect(() => decryptSecret(tampered)).toThrow(SecretConfigurationError);
  });

  it("rejects a value written with a different key", () => {
    const enc = encryptSecret(SECRET);
    process.env["NOTIFICATION_ENCRYPTION_KEY"] = "0".repeat(64);
    expect(() => decryptSecret(enc)).toThrow(SecretConfigurationError);
    process.env["NOTIFICATION_ENCRYPTION_KEY"] = KEY_HEX;
  });

  it("refuses to operate with no key configured", () => {
    const saved = process.env["NOTIFICATION_ENCRYPTION_KEY"];
    delete process.env["NOTIFICATION_ENCRYPTION_KEY"];
    expect(encryptionAvailable()).toBe(false);
    expect(() => encryptSecret("x")).toThrow(SecretConfigurationError);
    process.env["NOTIFICATION_ENCRYPTION_KEY"] = saved;
  });

  it("recognises its own stored format", () => {
    expect(isEncrypted(encryptSecret(SECRET))).toBe(true);
    expect(isEncrypted(SECRET)).toBe(false);
    expect(isEncrypted(null)).toBe(false);
  });
});

describe("redaction", () => {
  it.each([
    ["query key", `POST ${SECRET} failed`],
    ["access_token", "https://x.test/a?access_token=abcdef1234567890 failed"],
    ["bearer", "Authorization: Bearer abcdef1234567890xyz"],
    ["password", "https://x.test/a?password=hunter2hunter2"],
  ])("removes the credential from %s", (_label, text) => {
    const out = redactSecrets(text);
    expect(out).toContain("<redacted>");
    expect(out).not.toContain("693a91f6-7xxx-4bc4-97a0-0ec2sifa5aaa");
    expect(out).not.toContain("abcdef1234567890");
    expect(out).not.toContain("hunter2hunter2");
  });

  it("leaves innocuous text alone", () => {
    expect(redactSecrets("WeCom returned errcode 94000")).toBe("WeCom returned errcode 94000");
  });

  it("is safe on empty input", () => {
    expect(redactSecrets("")).toBe("");
  });
});

describe("displayWebhook", () => {
  it("hides the key but keeps four characters to tell robots apart", () => {
    const d = displayWebhook(SECRET);
    expect(d).not.toContain("693a91f6");
    expect(d).toContain("••••");
    expect(d).toContain("5aaa");
  });

  it("degrades to a full mask on unparseable input", () => {
    expect(displayWebhook("not a url")).toBe("••••••••••••••••");
  });
});

describe("safeEquals", () => {
  it("compares equal and unequal values", () => {
    expect(safeEquals("abc", "abc")).toBe(true);
    expect(safeEquals("abc", "abd")).toBe(false);
  });

  it("returns false on length mismatch without throwing", () => {
    expect(safeEquals("abc", "abcdef")).toBe(false);
  });
});

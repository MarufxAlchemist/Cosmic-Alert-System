/**
 * verify_wechat_tenant_isolation.ts
 * ---------------------------------
 * Proves that one lab cannot read, use or delete another lab's WeChat
 * credential.
 *
 * This is the property most worth testing directly: the JWT carries no labId,
 * so isolation depends entirely on the server resolving the lab from
 * lab_members on every request. A regression there would not fail a typecheck
 * and would not fail any single-user test — it would simply start returning
 * someone else's webhook.
 *
 * Creates a second user in a second lab, mints a token for them with the
 * server's own secret, and checks what each side can see.
 *
 * Run inside the api-server container:
 *   docker compose exec -T api-server node dist/scripts/verify_wechat_tenant_isolation.js
 * or with tsx against a running API.
 */

import jwt from "jsonwebtoken";
import { db, alertSubscriptions, labMembers, labs, users } from "@workspace/db";
import { and, eq } from "drizzle-orm";

const API = process.env["API_BASE"] ?? "http://localhost:8000/api";
const SECRET = process.env["JWT_SECRET"] ?? "astrosentinel-dev-secret";

const U1 = "wecom-test@astrosentinel.local";
const U2 = "other-lab@astrosentinel.local";
const WEBHOOK_2 = "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=demo1111-1111-4111-a111-1111111111ff";

let fail = 0;
const t = (name: string, cond: boolean, extra = "") => {
  if (!cond) fail++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  → " + extra : ""}`);
};

async function tokenFor(email: string): Promise<string> {
  const [u] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  if (!u) throw new Error(`user ${email} not found`);
  return jwt.sign({ userId: u.id, email: u.email, role: "researcher" }, SECRET, { expiresIn: "1h" });
}

async function ensureSecondTenant(): Promise<void> {
  const [existing] = await db.select().from(users).where(eq(users.email, U2)).limit(1);
  let userId = existing?.id;
  if (!userId) {
    const [created] = await db.insert(users).values({
      email: U2,
      name: "Other Lab",
      // Never used: this account is only ever authenticated by a minted token.
      passwordHash: "x".repeat(60),
    }).returning();
    userId = created!.id;
  }
  const [lab] = await db.select().from(labs).where(eq(labs.slug, "lab-two")).limit(1);
  const labId = lab?.id ?? (await db.insert(labs)
    .values({ slug: "lab-two", name: "Lab Two" }).returning())[0]!.id;

  const [member] = await db.select().from(labMembers)
    .where(and(eq(labMembers.userId, userId!), eq(labMembers.labId, labId))).limit(1);
  if (!member) {
    await db.insert(labMembers).values({ labId, userId: userId!, role: "member" });
  }
}

async function call(path: string, token: string, init: RequestInit = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(init.headers ?? {}),
    },
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body } as { status: number; body: any };
}

async function main() {
  await ensureSecondTenant();
  const t1 = await tokenFor(U1);
  const t2 = await tokenFor(U2);

  console.log("── Each lab sees only its own configuration ──");
  const g1 = await call("/notifications/wechat", t1);
  t("lab one has a webhook configured", g1.body?.configured === true);
  const u1Display: string = g1.body?.display ?? "";

  const g2 = await call("/notifications/wechat", t2);
  t("lab two starts with nothing", g2.body?.configured === false,
    `configured=${g2.body?.configured}`);
  t("lab two cannot see lab one's webhook",
    !g2.body?.display || g2.body.display !== u1Display);

  console.log("\n── After lab two configures its own ──");
  const put2 = await call("/notifications/wechat", t2, {
    method: "PUT", body: JSON.stringify({ webhookUrl: WEBHOOK_2 }),
  });
  t("lab two can save its own", put2.status === 200, `status ${put2.status}`);

  const a1 = await call("/notifications/wechat", t1);
  const a2 = await call("/notifications/wechat", t2);
  t("lab one still sees ONLY its own", a1.body?.display === u1Display, a1.body?.display);
  t("lab two sees ONLY its own", a2.body?.display !== u1Display, a2.body?.display);
  t("the two displays differ", a1.body?.display !== a2.body?.display);

  console.log("\n── No endpoint ever returns the secret ──");
  const serialised = JSON.stringify(a1.body) + JSON.stringify(a2.body);
  t("no v1: ciphertext in any response", !serialised.includes("v1:"));
  t("no raw key in any response",
    !serialised.includes("beef") || serialised.includes("••••beef"));
  t("display is redacted", /••••/.test(a1.body?.display ?? ""));

  console.log("\n── Deleting is scoped to the caller ──");
  const del2 = await call("/notifications/wechat", t2, { method: "DELETE" });
  t("lab two deletes its own", del2.status === 200);
  const after1 = await call("/notifications/wechat", t1);
  t("lab one's configuration SURVIVES lab two's delete",
    after1.body?.configured === true, `configured=${after1.body?.configured}`);

  console.log("\n── Unauthenticated access ──");
  const anon = await fetch(`${API}/notifications/wechat`);
  t("401 without a token", anon.status === 401, `status ${anon.status}`);

  // Leave the environment as we found it.
  const [u2row] = await db.select().from(users).where(eq(users.email, U2)).limit(1);
  if (u2row) {
    await db.delete(alertSubscriptions).where(eq(alertSubscriptions.userId, u2row.id));
  }

  console.log(fail === 0 ? "\nAll isolation checks passed." : `\n${fail} FAILED`);
  process.exit(fail === 0 ? 0 : 1);
}

void main();

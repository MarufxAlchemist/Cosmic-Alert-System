/**
 * routes/notificationsWechat.ts
 * -----------------------------
 * Configuration API for the WeChat channel (WeCom group robot webhook).
 *
 *   GET    /api/notifications/wechat        redacted status + health
 *   PUT    /api/notifications/wechat        save/replace the webhook
 *   DELETE /api/notifications/wechat        remove it
 *   POST   /api/notifications/wechat/test   send a test message
 *
 * THE INVARIANT THIS FILE EXISTS TO HOLD
 * ──────────────────────────────────────
 * The webhook URL is a bearer credential. It enters through PUT and never
 * leaves. There is deliberately NO endpoint that returns it — not for the
 * owner, not for an admin. GET returns only the redacted display string the
 * provider produced when it was stored, which is enough to tell two robots
 * apart and useless to anyone who does not already hold the key.
 *
 * TENANT ISOLATION
 * The JWT carries userId/email/role and NO labId, so the lab is resolved
 * server-side from lab_members on every request and every query is scoped by
 * (userId, labId). A caller cannot address another lab's configuration by
 * changing a token claim, because the claim does not exist.
 *
 * Storage: one alert_subscriptions row per channel. notificationService.ts
 * already filters `sub.channel !== "email"`, so this row is naturally skipped
 * by the email dispatcher and picked up by the WeChat one.
 */

import { Router } from "express";
import type { Request, Response } from "express";
import { and, desc, eq } from "drizzle-orm";
import { db, alerts, alertSubscriptions, labMembers } from "@workspace/db";

import { requireAuth, type AuthPayload } from "../middlewares/auth.js";
import { logger } from "../lib/logger.js";
import { wecomProvider } from "../notifications/providers/wechat/wecomWebhook.js";
import { redactSecrets, encryptionAvailable } from "../notifications/providers/secrets.js";
import { tryConsume } from "../notifications/providers/rateLimiter.js";

const router = Router();
const CHANNEL = "wechat";

/** Test sends per user per minute. Low: it posts to a real group. */
const TEST_LIMIT_PER_MIN = 5;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function actorOf(req: Request): { userId: string; email: string } {
  const a = (req as Request & { user: AuthPayload }).user;
  return { userId: (a.userId || (a as any).id) as string, email: a.email };
}

/**
 * Resolve the caller's lab. Mirrors notifications.ts rather than inventing a
 * second convention — two ways to answer "which lab is this user in?" is how
 * an authorization gap gets introduced.
 */
async function resolveActorLab(userId: string) {
  const [m] = await db
    .select()
    .from(labMembers)
    .where(eq(labMembers.userId, userId as any))
    .limit(1);
  return m ?? null;
}

async function findWeChatSub(userId: string, labId: string) {
  const [sub] = await db
    .select()
    .from(alertSubscriptions)
    .where(
      and(
        eq(alertSubscriptions.userId, userId as any),
        eq(alertSubscriptions.labId, labId as any),
        eq(alertSubscriptions.channel, CHANNEL),
      ),
    )
    .limit(1);
  return sub ?? null;
}

/**
 * Every error leaving this router passes through here.
 *
 * Provider and fetch errors routinely embed the request URL, and for this
 * transport the URL contains the key. Redacting at the single exit point is
 * the only version of this rule that cannot be forgotten at a call site.
 */
function safeError(res: Response, status: number, message: string) {
  res.status(status).json({ error: redactSecrets(message) });
}

/** 503 rather than 500: the service is fine, the deployment is misconfigured. */
function guardEncryption(res: Response): boolean {
  if (encryptionAvailable()) return true;
  safeError(
    res, 503,
    "Notification credential storage is unavailable: NOTIFICATION_ENCRYPTION_KEY " +
    "is not configured on the server.",
  );
  return false;
}

// ---------------------------------------------------------------------------
// GET — redacted status
// ---------------------------------------------------------------------------

router.get("/notifications/wechat", requireAuth, async (req, res) => {
  try {
    const { userId } = actorOf(req);
    const member = await resolveActorLab(userId);
    if (!member) return safeError(res, 403, "Not a lab member.");

    const sub = await findWeChatSub(userId, member.labId as unknown as string);
    if (!sub) {
      res.json({
        configured: false,
        display: null,
        health: "configuration_required",
        healthDetail: "No WeCom webhook has been saved for this account yet.",
      });
      return;
    }

    const cfg = sub.channelConfig as Record<string, unknown>;
    const health = await wecomProvider.healthCheck(cfg);

    // NOTE: `display` only. The webhook itself is never serialised here.
    res.json({
      configured: true,
      display: (cfg["display"] as string) ?? null,
      format: (cfg["format"] as string) ?? "markdown",
      enabled: sub.isActive,
      health: health.status,
      healthDetail: health.detail,
      checkedAt: health.checkedAt,
    });
  } catch (err) {
    logger.error({ err }, "[notifications/wechat] GET failed");
    safeError(res, 500, "Could not read the WeChat configuration.");
  }
});

// ---------------------------------------------------------------------------
// PUT — save / replace
// ---------------------------------------------------------------------------

router.put("/notifications/wechat", requireAuth, async (req, res) => {
  if (!guardEncryption(res)) return;
  try {
    const { userId } = actorOf(req);
    const member = await resolveActorLab(userId);
    if (!member) return safeError(res, 403, "Not a lab member.");

    const webhookUrl = (req.body ?? {}).webhookUrl;
    const format = (req.body ?? {}).format ?? "markdown";

    // Validate BEFORE touching the database, and before anything is logged.
    const validation = wecomProvider.validateConfiguration({ webhookUrl, format });
    if (!validation.valid) {
      // Field-level messages are safe: they describe the shape, never the key.
      return safeError(res, 400, validation.errors.join(" "));
    }

    const { config, display } = wecomProvider.prepareForStorage({ webhookUrl, format });

    const labId = member.labId as unknown as string;
    const existing = await findWeChatSub(userId, labId);

    if (existing) {
      await db
        .update(alertSubscriptions)
        .set({ channelConfig: config, isActive: true, updatedAt: new Date() })
        .where(eq(alertSubscriptions.id, existing.id));
    } else {
      await db.insert(alertSubscriptions).values({
        userId: userId as any,
        labId: labId as any,
        name: "WeChat alerts",
        channel: CHANNEL,
        channelConfig: config,
        // Sensible defaults; the preferences form refines them afterwards.
        eventTypes: ["GRB", "GW", "FRB", "NU"],
        priorityLevel: "critical_and_high",
        observatories: [],
        isActive: true,
      });
    }

    // Logged WITHOUT the URL. `display` is already redacted.
    logger.info(
      { userId, labId, channel: CHANNEL, display, event: "notification.config.saved" },
      "[notifications/wechat] Webhook configuration saved",
    );

    res.json({ configured: true, display, health: "unknown" });
  } catch (err) {
    logger.error({ err: redactSecrets(String(err)) }, "[notifications/wechat] PUT failed");
    safeError(res, 500, "Could not save the WeChat configuration.");
  }
});

// ---------------------------------------------------------------------------
// DELETE — remove
// ---------------------------------------------------------------------------

router.delete("/notifications/wechat", requireAuth, async (req, res) => {
  try {
    const { userId } = actorOf(req);
    const member = await resolveActorLab(userId);
    if (!member) return safeError(res, 403, "Not a lab member.");

    const labId = member.labId as unknown as string;
    const existing = await findWeChatSub(userId, labId);
    if (!existing) {
      res.json({ configured: false });
      return;
    }

    // Delete the row rather than blanking the config: leaving an inactive row
    // holding ciphertext keeps a credential we were asked to discard.
    await db.delete(alertSubscriptions).where(eq(alertSubscriptions.id, existing.id));

    logger.info(
      { userId, labId, channel: CHANNEL, event: "notification.config.removed" },
      "[notifications/wechat] Webhook configuration removed",
    );
    res.json({ configured: false });
  } catch (err) {
    logger.error({ err }, "[notifications/wechat] DELETE failed");
    safeError(res, 500, "Could not remove the WeChat configuration.");
  }
});

// ---------------------------------------------------------------------------
// POST /test
// ---------------------------------------------------------------------------

router.post("/notifications/wechat/test", requireAuth, async (req, res) => {
  if (!guardEncryption(res)) return;
  try {
    const { userId } = actorOf(req);
    const member = await resolveActorLab(userId);
    if (!member) return safeError(res, 403, "Not a lab member.");

    // Rate limited per user: this endpoint posts to a real WeCom group, so an
    // unbounded one is a spam vector against the user's own colleagues, and it
    // would burn the robot's 20/min budget that real alerts need.
    const gate = tryConsume(`wechat-test:${userId}`, TEST_LIMIT_PER_MIN);
    if (!gate.allowed) {
      res.status(429).json({
        ok: false,
        error: `Too many test notifications. Try again in ${Math.ceil(gate.retryAfterMs / 1000)}s.`,
      });
      return;
    }

    const labId = member.labId as unknown as string;
    const sub = await findWeChatSub(userId, labId);
    if (!sub) {
      return safeError(res, 400, "No WeCom webhook is configured. Save one before sending a test.");
    }

    const result = await wecomProvider.test(sub.channelConfig as Record<string, unknown>);

    if (result.ok) {
      logger.info(
        { userId, labId, channel: CHANNEL, durationMs: result.durationMs,
          event: "notification.test.sent" },
        "[notifications/wechat] Test notification delivered",
      );
      res.json({ ok: true, durationMs: result.durationMs });
      return;
    }

    logger.warn(
      { userId, labId, channel: CHANNEL, kind: result.kind, code: result.code,
        event: "notification.test.failed" },
      "[notifications/wechat] Test notification failed",
    );
    // 200 with ok:false — the request was handled correctly; the PROVIDER
    // rejected it. A 5xx here would read as an Transient Event Detection fault and send
    // the user looking in the wrong place.
    res.json({ ok: false, kind: result.kind, error: redactSecrets(result.message) });
  } catch (err) {
    logger.error({ err: redactSecrets(String(err)) }, "[notifications/wechat] test failed");
    safeError(res, 500, "Could not send the test notification.");
  }
});

// ---------------------------------------------------------------------------
// GET /notifications/deliveries — recent delivery history
// ---------------------------------------------------------------------------

/**
 * What actually happened to this user's notifications.
 *
 * The point of surfacing this is that "I didn't get an alert" and "no alert was
 * sent" are indistinguishable from the outside. A researcher needs to be able
 * to tell a quiet sky from a broken webhook.
 *
 * Scoped to the caller's own subscriptions. error_message is included because
 * it is the actionable part ("the webhook was deleted in WeCom") — it has
 * already been redacted at write time by the dispatcher, and is redacted again
 * here, since a row could predate that guarantee.
 */
router.get("/notifications/deliveries", requireAuth, async (req, res) => {
  try {
    const { userId } = actorOf(req);
    const member = await resolveActorLab(userId);
    if (!member) return safeError(res, 403, "Not a lab member.");

    const limit = Math.min(Number(req.query["limit"] ?? 25) || 25, 100);

    // Join through the subscription so a caller only ever sees deliveries for
    // subscriptions they own — scoping on alerts.lab_id alone would expose
    // every colleague's deliveries within the same lab.
    const rows = await db
      .select({
        id: alerts.id,
        channel: alerts.channel,
        provider: alerts.provider,
        status: alerts.status,
        retryCount: alerts.retryCount,
        failureKind: alerts.failureKind,
        errorCode: alerts.errorCode,
        errorMessage: alerts.errorMessage,
        sentAt: alerts.sentAt,
        nextRetryAt: alerts.nextRetryAt,
        createdAt: alerts.createdAt,
        payload: alerts.payload,
      })
      .from(alerts)
      .innerJoin(alertSubscriptions, eq(alerts.subscriptionId, alertSubscriptions.id))
      .where(and(
        eq(alertSubscriptions.userId, userId as any),
        eq(alertSubscriptions.labId, member.labId as any),
      ))
      .orderBy(desc(alerts.createdAt))
      .limit(limit);

    res.json({
      deliveries: rows.map((r) => {
        const p = (r.payload ?? {}) as Record<string, unknown>;
        return {
          id: String(r.id),
          eventId: String(p["eventId"] ?? ""),
          eventType: String((p["event"] as any)?.eventType ?? ""),
          priority: String(p["priority"] ?? ""),
          revisionCount: Number(p["revisionCount"] ?? 0),
          channel: r.channel,
          provider: r.provider,
          status: r.status,
          attempts: r.retryCount ?? 0,
          failureKind: r.failureKind,
          errorCode: r.errorCode,
          error: r.errorMessage ? redactSecrets(r.errorMessage) : null,
          sentAt: r.sentAt?.toISOString() ?? null,
          nextRetryAt: r.nextRetryAt?.toISOString() ?? null,
          createdAt: r.createdAt.toISOString(),
        };
      }),
    });
  } catch (err) {
    logger.error({ err }, "[notifications/deliveries] GET failed");
    safeError(res, 500, "Could not read the delivery history.");
  }
});

export default router;

/**
 * notificationService.ts
 * ----------------------
 * Orchestrator for the notification pipeline.
 *
 * This is the ONLY public surface called from outside the notifications/
 * module. kafkaConsumer.ts imports and calls dispatchForEvent() — nothing else.
 *
 * Pipeline
 * ────────
 *   dispatchForEvent(event, isRevision)
 *     │
 *     ├─ 1. Check NOTIFY_ON_REVISIONS env var. Skip revisions if disabled.
 *     │
 *     ├─ 2. Classify event via the Phase 5.2 Scientific Priority Engine.
 *     │       classify() → { priority: P0/P1/P2/P3, score, reasons[], recommendation }
 *     │
 *     ├─ 3. P2/P3 → skip notification (digest or DB-only).
 *     │     P0/P1 → proceed to email.
 *     │
 *     ├─ 4. Parse recipient list from NOTIFICATION_RECIPIENTS env var.
 *     │
 *     ├─ 5. Map P0→CRITICAL, P1→HIGH for email template badge colour.
 *     │
 *     ├─ 6. Build email content via notificationTemplates.buildEmailContent()
 *     │
 *     └─ 7. Enqueue one job per recipient via notificationQueue
 *
 * Extensibility
 * ─────────────
 *   Future channels (WeChat/WeCom, QQ, Webhooks) add their own dispatch
 *   call here without touching kafkaConsumer.ts or the email stack.
 *
 * Error handling
 * ──────────────
 *   dispatchForEvent() never throws. All errors are caught and logged.
 *   kafkaConsumer.ts wraps the call in void ... .catch() as a safety net.
 *
 * Phase 5.1 (email infrastructure) + Phase 5.2 (scientific priority engine)
 * Phase 5.3 (scientific email templates) + Phase 5.4 (multi-messenger correlation)
 */

import { logger }                 from "../lib/logger.js";
import { classify }               from "../science/priorityEngine/index.js";
import type { EventClassificationInput } from "../science/priorityEngine/index.js";
import { correlate }              from "../science/correlationEngine/index.js";
import type { CorrelationEvent }  from "../science/correlationEngine/index.js";
import { toNotificationPriority } from "./priorityEngine.js";
import { buildEmailContent }      from "./notificationTemplates.js";
import { createEmailProvider }    from "./emailService.js";
import { enqueueNotificationJob } from "./notificationQueue.js";
import { decide, recordDecision } from "./deduplicationEngine/index.js";
import { enqueueDeliveries, processDueDeliveries, toPriority } from "./notificationDispatcher.js";
import { db, eventsTable, alertSubscriptions } from "@workspace/db";
import { gte, eq } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Configuration helpers
// ---------------------------------------------------------------------------

/**
 * Fetch active subscriptions from the DB matching event criteria.
 */
async function getMatchingSubscriptions(eventType: string, observatory: string, priorityLevel: string) {
  try {
    const activeSubs = await db
      .select()
      .from(alertSubscriptions)
      .where(eq(alertSubscriptions.isActive, true));

    // In-memory filter for now (array containment is tricky with basic drizzle operators)
    return activeSubs.filter(sub => {
      // 1. Priority Level matching
      if (sub.priorityLevel === "critical_only" && priorityLevel !== "P0") return false;
      if (sub.priorityLevel === "critical_and_high" && priorityLevel !== "P0" && priorityLevel !== "P1") return false;
      // "all" accepts everything

      // 2. Event Type matching
      if (sub.eventTypes.length > 0 && !sub.eventTypes.includes(eventType)) return false;

      // 3. Observatory matching
      if (sub.observatories.length > 0 && !sub.observatories.includes(observatory)) return false;

      // We only support email channels right now
      if (sub.channel !== "email") return false;

      const email = (sub.channelConfig as Record<string, string>)?.email;
      if (!email) return false;

      return true;
    });
  } catch (err) {
    logger.warn({ err }, "[notifications] Failed to fetch subscriptions");
    return [];
  }
}

function shouldNotifyOnRevisions(): boolean {
  return (process.env["NOTIFY_ON_REVISIONS"] ?? "false").toLowerCase() === "true";
}

// ---------------------------------------------------------------------------
// Correlation candidate fetch (Phase 5.4)
// ---------------------------------------------------------------------------

/**
 * Fetch recent events from the database to use as correlation candidates.
 * Scoped to the lookback window configured by CORR_DB_LOOKBACK_MINUTES.
 * Excludes the primary event itself.
 *
 * Non-throwing — returns empty array on any DB error so correlation
 * failure never interrupts the notification pipeline.
 */
async function fetchCandidateEvents(
  primaryEventId: string,
  lookbackMinutes: number,
): Promise<CorrelationEvent[]> {
  try {
    const since = new Date(Date.now() - lookbackMinutes * 60 * 1000);
    const rows = await db
      .select({
        eventId:       eventsTable.eventId,
        eventType:     eventsTable.eventType,
        observatory:   eventsTable.observatory,
        detectionTime: eventsTable.detectionTime,
        ra:            eventsTable.ra,
        dec:           eventsTable.dec,
        errorRadius:   eventsTable.errorRadius,
        isRetraction:  eventsTable.isRetraction,
      })
      .from(eventsTable)
      .where(
        gte(eventsTable.detectionTime, since),
      )
      .limit(50);

    return rows
      .filter((r) => r.eventId !== primaryEventId)
      .map((r) => ({
        eventId:       r.eventId,
        eventType:     r.eventType,
        observatory:   r.observatory,
        detectionTime: r.detectionTime instanceof Date
          ? r.detectionTime.toISOString()
          : String(r.detectionTime),
        ra:            r.ra,
        dec:           r.dec,
        errorRadius:   r.errorRadius,
        isRetraction:  r.isRetraction,
      }));
  } catch (err) {
    logger.warn({ err }, "[notifications] fetchCandidateEvents failed — correlation skipped");
    return [];
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Dispatch notifications for a newly accepted (or revised) event.
 *
 * @param event       - The broadcast payload object from kafkaConsumer.ts.
 * @param isRevision  - true when revisionCount > 0.
 */
export async function dispatchForEvent(
  event: Record<string, unknown>,
  isRevision: boolean,
): Promise<void> {
  try {
    // ── 1. Revision gate ──────────────────────────────────────────────────
    if (isRevision && !shouldNotifyOnRevisions()) {
      logger.debug(
        { eventId: event["eventId"] },
        "[notifications] Revision notification skipped (NOTIFY_ON_REVISIONS=false)",
      );
      return;
    }

    // ── 2. Scientific priority classification (Phase 5.2 engine) ─────────
    const classificationInput: EventClassificationInput = {
      eventType:          String(event["eventType"]          ?? "GRB"),
      observatory:        String(event["observatory"]        ?? ""),
      lifecycle:          String(event["lifecycle"]          ?? "preliminary"),
      alertType:          (event["alertType"] as string | null) ?? null,
      classificationTier: (event["classificationTier"] as string | null) ?? null,
      snr:                Number(event["snr"]                ?? 0),
      far:                Number(event["far"]                ?? 0),
      errorRadius:        Number(event["errorRadius"]        ?? 0),
      isRetraction:       Boolean(event["isRetraction"]      ?? false),
      isHistorical:       Boolean(event["isHistorical"]      ?? false),
      revisionCount:      Number(event["revisionCount"]      ?? 0),
      fluence:            event["fluence"]            != null ? Number(event["fluence"])            : null,
      t90:                event["t90"]                != null ? Number(event["t90"])                : null,
      dm:                 event["dm"]                 != null ? Number(event["dm"])                 : null,
      chirpMass:          event["chirpMass"]          != null ? Number(event["chirpMass"])          : null,
      luminosityDistance: event["luminosityDistance"] != null ? Number(event["luminosityDistance"]) : null,
    };

    const result = classify(classificationInput);

    logger.info(
      {
        eventId:        event["eventId"],
        priority:       result.priority,
        score:          result.score,
        reasons:        result.reasons,
        recommendation: result.recommendation,
      },
      `[notifications] Scientific classification: ${result.priority} (score=${result.score})`,
    );

    // ── 3. Priority gate — P2/P3 do not trigger email ─────────────────────
    if (result.priority === "P2" || result.priority === "P3") {
      logger.debug(
        { eventId: event["eventId"], priority: result.priority, score: result.score },
        `[notifications] ${result.priority} event — ${result.priority === "P2" ? "digest-only" : "database-only"}, no email`,
      );
      return;
    }

    // ── 4. Subscribers ────────────────────────────────────────────────────
    const eventTypeStr = String(event["eventType"] ?? "GRB");
    const observatoryStr = String(event["observatory"] ?? "");
    const subscriptions = await getMatchingSubscriptions(eventTypeStr, observatoryStr, result.priority);

    if (subscriptions.length === 0) {
      logger.info(
        { eventId: event["eventId"] },
        "[notifications] No active subscriptions match this event — no emails will be sent",
      );
      return;
    }

    // ── 5. Map P0/P1 → template badge colour ──────────────────────────────
    const notificationPriority = toNotificationPriority(result.priority);

    // ── 5a. Multi-messenger correlation (Phase 5.4) ────────────────────────
    // Fetch recent events from DB, run correlation engine, log result.
    // Non-throwing: correlation failure never blocks email dispatch.
    const { getCoincidenceWindows } = await import("../science/correlationEngine/index.js");
    const corrWindows = getCoincidenceWindows();
    const candidateEvents = await fetchCandidateEvents(
      String(event["eventId"] ?? ""),
      corrWindows.dbLookbackMinutes,
    );
    const correlationResult = correlate({
      primary_event: {
        eventId:       String(event["eventId"]       ?? ""),
        eventType:     String(event["eventType"]     ?? ""),
        observatory:   String(event["observatory"]   ?? ""),
        detectionTime: String(event["detectionTime"] ?? new Date().toISOString()),
        ra:            Number(event["ra"]            ?? 0),
        dec:           Number(event["dec"]           ?? 0),
        errorRadius:   Number(event["errorRadius"]   ?? 0),
        isRetraction:  Boolean(event["isRetraction"] ?? false),
      },
      candidate_events: candidateEvents,
    });
    logger.info(
      {
        eventId:    event["eventId"],
        confidence: correlationResult.confidence,
        nCandidates: candidateEvents.length,
        bestMatch:  correlationResult.bestMatch?.candidate.eventId ?? null,
      },
      `[notifications] Correlation: ${correlationResult.confidence} (${candidateEvents.length} candidates)`,
    );

    // ── 5b. Deduplication Engine (Phase 5.5) ──────────────────────────────
    const dedupDecision = await decide({
      eventId:       String(event["eventId"]       ?? ""),
      lifecycle:     String(event["lifecycle"]     ?? ""),
      revisionCount: Number(event["revisionCount"] ?? 0),
      errorRadius:   Number(event["errorRadius"]   ?? 0),
      isRetraction:  Boolean(event["isRetraction"] ?? false),
      classification: result,
      correlation: correlationResult,
    });

    const snapshot = {
      eventId:        String(event["eventId"]       ?? ""),
      lifecycle:      String(event["lifecycle"]     ?? "").toLowerCase(),
      revisionCount:  Number(event["revisionCount"] ?? 0),
      priorityLevel:  result.priority,
      priorityScore:  result.score,
      corrConfidence: correlationResult.confidence,
      errorRadius:    Number(event["errorRadius"]   ?? 0),
    };

    if (!dedupDecision.send) {
      logger.info(
        { eventId: event["eventId"], reasons: dedupDecision.reasons },
        `[notifications] Deduplication engine suppressed email`,
      );
      await recordDecision({
        snapshot,
        suppressed: true,
        triggerReasons: dedupDecision.reasons,
      });
      return; // Halt dispatch
    }

    logger.info(
      { eventId: event["eventId"], triggers: dedupDecision.triggers },
      `[notifications] Deduplication engine approved email`,
    );

    // ── 5b. Provider channels (WeChat, …) ─────────────────────────────────
    //
    // Placed AFTER the deduplication gate so every channel inherits the same
    // suppression decision: a revision judged insignificant must not reach a
    // WeChat group just because it was blocked from email.
    //
    // Fire-and-forget and non-throwing. The email path below must not be
    // delayed by a WeCom round-trip, and a provider outage must not prevent
    // the email that would otherwise have gone out.
    void enqueueDeliveries(
      {
        eventId:       String(event["eventId"] ?? ""),
        eventType:     String(event["eventType"] ?? ""),
        observatory:   String(event["observatory"] ?? ""),
        lifecycle:     String(event["lifecycle"] ?? "preliminary").toLowerCase(),
        revisionCount: Number(event["revisionCount"] ?? 0),
        isRetraction:  Boolean(event["isRetraction"] ?? false),
        raw:           event,
      },
      toPriority(result.priority),
    ).then((n) => {
      if (n > 0) void processDueDeliveries();
    }).catch((err) =>
      logger.error({ err, eventId: event["eventId"] },
        "[notifications] provider-channel dispatch threw"),
    );

    // ── 5c. AI Scientific Summary Engine (Phase 5.6, guarded in Phase 7) ──
    //
    // The context is built by the science layer from measured values only,
    // with every unknown stated as unknown. It previously coerced absent
    // measurements to 0 — presenting an unlocalized event as sitting at
    // (0, 0) and an event with no false-alarm rate as having FAR = 0 Hz,
    // i.e. infinite significance. See science/aiGuard.ts.
    const { generateSummary } = await import("../science/summaryEngine/index.js");
    const { buildAiContext, verifyAiOutput } = await import("../science/aiGuard.js");

    const aiContext = await buildAiContext(event);

    let aiSummary: Awaited<ReturnType<typeof generateSummary>> | null = null;
    if (!aiContext) {
      // Skipping is the correct degraded mode: the email template already
      // falls back to rendering the raw data, which is honest. Generating a
      // confident paragraph from unvalidated input is not.
      logger.warn(
        { eventId: event["eventId"] },
        "[notifications] AI summary skipped — validated context unavailable",
      );
    } else {
      const eventMetadata = {
        ...aiContext,
        priorityLevel: result.priority,
        priorityScore: result.score,
      };

      // Non-blocking timeout-safe summary generation
      aiSummary = await generateSummary(
        event["id"] as number | string,
        eventMetadata,
        correlationResult as unknown as Record<string, unknown>
      );

      // Instructions are not a guarantee: screen the result for numbers that
      // were never supplied. A failed screen is not a pass.
      if (aiSummary) {
        const verification = await verifyAiOutput(eventMetadata, aiSummary);
        if (verification && !verification.trusted) {
          logger.warn(
            {
              eventId: event["eventId"],
              unsupported: verification.unsupported.map((u) => u.text),
            },
            "[notifications] AI summary quotes values absent from its context — " +
              "withholding it from the email",
          );
          aiSummary = null;
        } else if (!verification) {
          logger.warn(
            { eventId: event["eventId"] },
            "[notifications] AI output could not be screened; treating as unverified",
          );
          aiSummary = null;
        }
      }
    }

    // ── 7. Enqueue one job per recipient ──────────────────────────────────
    const provider = createEmailProvider();

    logger.info(
      {
        eventId:    event["eventId"],
        priority:   result.priority,
        score:      result.score,
        subscribers: subscriptions.length,
        provider:   provider.name,
        reasons:    result.reasons,
      },
      `[notifications] Dispatching ${result.priority} alert to ${subscriptions.length} subscriber(s) — ${result.recommendation}`,
    );

    for (const sub of subscriptions) {
      const email = (sub.channelConfig as Record<string, string>).email;
      const subBehaviour = sub.behaviour || { aiSummary: true, correlation: true, localization: true };

      // Optional Phase 5.7 behaviour overrides per user
      const userContent = buildEmailContent(
        {
          eventId:            String(event["eventId"]            ?? "UNKNOWN"),
          triggerId:          event["triggerId"] != null ? String(event["triggerId"]) : null,
          eventType:          String(event["eventType"]          ?? "GRB"),
          observatory:        String(event["observatory"]        ?? "Unknown"),
          detectionTime:      String(event["detectionTime"]      ?? new Date().toISOString()),
          lifecycle:          String(event["lifecycle"]          ?? "preliminary"),
          alertType:          (event["alertType"] as string | null) ?? null,
          classificationTier: (event["classificationTier"] as string | null) ?? null,
          revisionCount:      Number(event["revisionCount"]      ?? 0),
          priorityLevel:      result.priority,
          priorityScore:      result.score,
          priorityReasons:    result.reasons,
          recommendation:     result.recommendation,
          correlationResult:  subBehaviour.correlation 
                                ? correlationResult 
                                : { confidence: "NONE", bestMatch: null } as any,
          aiSummary:          subBehaviour.aiSummary ? aiSummary : null,
          ra:                 Number(event["ra"]                 ?? 0),
          dec:                Number(event["dec"]                ?? 0),
          errorRadius:        Number(event["errorRadius"]        ?? 0),
          snr:                Number(event["snr"]                ?? 0),
          far:                Number(event["far"]                ?? 0),
          fluence:            event["fluence"]            != null ? Number(event["fluence"])            : null,
          dm:                 event["dm"]                 != null ? Number(event["dm"])                 : null,
          t90:                event["t90"]                != null ? Number(event["t90"])                : null,
          chirpMass:          event["chirpMass"]          != null ? Number(event["chirpMass"])          : null,
          luminosityDistance: event["luminosityDistance"] != null ? Number(event["luminosityDistance"]) : null,
          latencyUs:          event["latencyUs"]          != null ? Number(event["latencyUs"])          : null,
        },
        notificationPriority,
      );

      enqueueNotificationJob(
        String(event["eventId"] ?? "UNKNOWN"),
        email,
        userContent,
        provider,
      );
    }

    // ── 8. Record sent decision for deduplication ─────────────────────────
    await recordDecision({
      snapshot,
      suppressed: false,
      triggerReasons: dedupDecision.reasons,
    });

  } catch (err) {
    // This function must NEVER throw — kafkaConsumer cannot be interrupted.
    logger.error(
      { err, eventId: event["eventId"] },
      "[notifications] dispatchForEvent encountered an unexpected error",
    );
  }
}

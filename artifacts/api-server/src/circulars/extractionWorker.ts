/**
 * extractionWorker.ts — the AI enrichment loop for GCN Circulars
 * ---------------------------------------------------------------------------
 * WHY A DATABASE TABLE AND A POLL LOOP, NOT A QUEUE SERVER
 * --------------------------------------------------------
 * The same reasoning as notifications/notificationDispatcher.ts, which this
 * mirrors deliberately: an in-memory queue loses its contents on restart, and
 * retries here are time-based, so something has to look at a clock. Rows in
 * core.circular_extractions with `next_attempt_at`, claimed with FOR UPDATE
 * SKIP LOCKED, give durability and safe concurrency across two api-server
 * containers with no Redis, no BullMQ and no new Kafka topic.
 *
 * THE INVARIANT
 * -------------
 * Nothing in this file can lose a circular. It only ever reads circulars and
 * writes extraction rows. The worst outcome of a total provider outage is a
 * table full of rows in state 'failed' beside circulars that remain stored,
 * associated and fully readable — with the UI saying the enrichment failed,
 * which is true, rather than showing an empty extraction, which would read as
 * "this circular reported nothing".
 *
 * RETRIES ARE BOUNDED AND KIND-AWARE
 * ----------------------------------
 * A missing API key and a schema-violating response are not transient. Trying
 * them again five times with backoff costs quota and delays every other job in
 * the queue, and cannot succeed. They fail immediately; only genuinely
 * transient kinds walk the backoff ladder.
 */

import { and, eq, sql } from "drizzle-orm";
import { db, circularExtractions, eventCirculars, eventsTable } from "@workspace/db";

import { logger } from "../lib/logger.js";
import { classifyFailure, decideExtractionRetry } from "./extractionRetry.js";
import { broadcastCircularEnriched } from "../lib/eventBroadcaster.js";
import { createDefaultProvider } from "../services/ai/provider.js";
import { CircularExtractionAgent } from "../services/ai/circular-extraction-agent.js";

// ─── Configuration ───────────────────────────────────────────────────────────

function batchSize(): number {
  const raw = Number(process.env["CIRCULAR_EXTRACTION_BATCH"]);
  return Number.isInteger(raw) && raw > 0 ? raw : 3;
}

function pollIntervalMs(): number {
  const raw = Number(process.env["CIRCULAR_EXTRACTION_POLL_MS"]);
  return Number.isFinite(raw) && raw >= 1000 ? raw : 15_000;
}

/**
 * Whether the enrichment loop runs at all.
 *
 * Off means circulars are still ingested, associated and served — they simply
 * carry no AI extraction. That is a legitimate way to run this system.
 */
export function extractionEnabled(): boolean {
  return process.env["CIRCULAR_AI_EXTRACTION"] !== "false";
}

// ─── Provider singleton ──────────────────────────────────────────────────────
//
// Constructed on first use rather than at import, so a deployment with no LLM
// configured starts normally and only reports the misconfiguration when an
// extraction is actually attempted.

let _agent: CircularExtractionAgent | null = null;
let _agentError: string | null = null;

function getAgent(): CircularExtractionAgent {
  if (_agent) return _agent;
  if (_agentError) throw new Error(_agentError);
  try {
    _agent = new CircularExtractionAgent(createDefaultProvider());
    logger.info({ provider: _agent.providerName }, "[circulars] extraction provider ready");
    return _agent;
  } catch (err) {
    // Cached so a missing key does not re-throw from the SDK constructor on
    // every single job in the batch.
    _agentError = err instanceof Error ? err.message : String(err);
    throw err;
  }
}

/** Reset the memoised provider. Used by tests and after a config change. */
export function resetExtractionProvider(): void {
  _agent = null;
  _agentError = null;
}

/**
 * The model name recorded on a queued job.
 *
 * Part of the cache key, so it must be resolvable without a working provider —
 * otherwise a temporarily-unconfigured server would queue jobs under a
 * different key than a configured one and re-extract everything later.
 */
export function configuredModelName(): string {
  try {
    return createDefaultProvider().name;
  } catch {
    return "unconfigured";
  }
}

// ─── One job ─────────────────────────────────────────────────────────────────

interface ClaimedJob {
  id: bigint;
  circularPk: bigint;
  attempts: number;
}

async function runOne(job: ClaimedJob): Promise<void> {
  const [circular] = await db
    .select()
    .from(eventCirculars)
    .where(eq(eventCirculars.id, job.circularPk))
    .limit(1);

  if (!circular) {
    // The circular was deleted between queueing and claiming. Nothing to
    // extract from; the ON DELETE CASCADE will remove this row shortly.
    await db
      .update(circularExtractions)
      .set({
        status: "failed",
        failureKind: "invalid_response",
        lastError: "The circular this extraction refers to no longer exists.",
        updatedAt: new Date(),
      })
      .where(eq(circularExtractions.id, job.id));
    return;
  }

  // Minimal event context: identifier and type only. Handing the model the
  // event's stored measurements would invite it to "confirm" numbers this
  // circular never mentioned (spec sections 27 and 42).
  let eventContext: { eventId: string; eventType: string } | null = null;
  if (circular.eventPk != null) {
    const [ev] = await db
      .select({ eventId: eventsTable.eventId, eventType: eventsTable.eventType })
      .from(eventsTable)
      .where(eq(eventsTable.id, circular.eventPk))
      .limit(1);
    eventContext = ev ?? null;
  }

  const agent = getAgent();

  const extraction = await agent.extract({
    circularId: circular.circularId,
    version: circular.version,
    subject: circular.subject,
    body: circular.body,
    submitter: circular.submitter,
    createdOn: circular.createdOn.toISOString(),
    event: eventContext,
  });

  const now = new Date();
  await db
    .update(circularExtractions)
    .set({
      status: "completed",
      extraction: extraction as unknown as Record<string, unknown>,
      extractedAt: now,
      provider: agent.providerName,
      failureKind: null,
      lastError: null,
      nextAttemptAt: null,
      updatedAt: now,
    })
    .where(eq(circularExtractions.id, job.id));

  logger.info(
    {
      circularId: circular.circularId,
      version: circular.version,
      eventPk: circular.eventPk != null ? String(circular.eventPk) : null,
      provider: agent.providerName,
      attempts: job.attempts + 1,
    },
    "[circulars] AI extraction persisted",
  );

  broadcastCircularEnriched({
    id: String(circular.id),
    circularId: circular.circularId,
    version: circular.version,
    eventPk: circular.eventPk != null ? String(circular.eventPk) : null,
    eventId: eventContext?.eventId ?? null,
    status: "completed",
    provider: agent.providerName,
  });
}

async function handleFailure(job: ClaimedJob, err: unknown): Promise<void> {
  const kind = classifyFailure(err);
  const decision = decideExtractionRetry(kind, job.attempts);
  // Truncated: a provider can return a very long error body, and an unbounded
  // string in a column read by the UI is its own problem.
  const message = (err instanceof Error ? err.message : String(err)).slice(0, 1000);

  await db
    .update(circularExtractions)
    .set({
      status: decision.action === "retry" ? "pending" : "failed",
      failureKind: kind,
      lastError: message,
      nextAttemptAt: decision.nextAttemptAt ?? null,
      updatedAt: new Date(),
    })
    .where(eq(circularExtractions.id, job.id));

  logger.error(
    {
      extractionId: String(job.id),
      circularPk: String(job.circularPk),
      failureKind: kind,
      attempts: job.attempts,
      willRetry: decision.action === "retry",
      nextAttemptAt: decision.nextAttemptAt?.toISOString() ?? null,
      // The message is logged; the API key never appears in it because every
      // provider adapter keeps the key in a header, not in error text.
      error: message,
    },
    decision.action === "retry"
      ? "[circulars] AI extraction failed — will retry. The circular remains stored and visible."
      : "[circulars] AI extraction failed permanently. The circular remains stored and visible.",
  );
}

// ─── The claim + drain cycle ─────────────────────────────────────────────────

/**
 * Claim and run up to `batch` due extractions.
 *
 * THE LIMIT IS INSIDE THE CLAIM, NOT AROUND THE LOOP — the same trap
 * migration 0018's dispatcher documents. Flipping every due row to
 * 'processing' and then iterating only the first N strands the remainder in a
 * state the claim query does not look for, and they are never picked up again.
 *
 * Returns how many jobs were attempted, for logging and tests.
 */
export async function processDueExtractions(
  batch = batchSize(),
  now = new Date(),
): Promise<number> {
  let handled = 0;

  let rows: Record<string, unknown>[];
  try {
    const claimed = await db.execute(sql`
      UPDATE core.circular_extractions
         SET status = 'processing',
             attempts = attempts + 1,
             updated_at = ${now}
       WHERE id IN (
         SELECT id FROM core.circular_extractions
          WHERE status = 'pending'
            AND (next_attempt_at IS NULL OR next_attempt_at <= ${now})
          ORDER BY created_at
          FOR UPDATE SKIP LOCKED
          LIMIT ${batch}
       )
       RETURNING id, circular_pk, attempts
    `);
    rows =
      ((claimed as unknown as { rows?: unknown[] }).rows as Record<string, unknown>[]) ??
      (claimed as unknown as Record<string, unknown>[]);
  } catch (err) {
    logger.error({ err }, "[circulars] extraction claim query failed");
    return 0;
  }

  for (const raw of rows) {
    const job: ClaimedJob = {
      id: raw["id"] as bigint,
      circularPk: raw["circular_pk"] as bigint,
      // The claim already incremented it, so `attempts` is the count INCLUDING
      // this one. The retry decision wants attempts made so far.
      attempts: Number(raw["attempts"] ?? 1),
    };
    handled++;

    try {
      await runOne(job);
    } catch (err) {
      try {
        await handleFailure(job, err);
      } catch (bookkeepingErr) {
        // A row stuck in 'processing' is recovered by reapStuckJobs() below.
        logger.error(
          { err: bookkeepingErr, extractionId: String(job.id) },
          "[circulars] could not record extraction failure",
        );
      }
    }
  }

  return handled;
}

/**
 * Return jobs abandoned in 'processing' to the queue.
 *
 * A container killed mid-extraction leaves its claimed rows flipped to
 * 'processing' with no worker behind them. Nothing else looks for that state,
 * so without this they would sit there for ever — the exact silent-loss
 * failure the durable queue exists to prevent.
 */
export async function reapStuckJobs(staleAfterMs = 10 * 60_000, now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - staleAfterMs);
  try {
    const reaped = await db
      .update(circularExtractions)
      .set({ status: "pending", nextAttemptAt: null, updatedAt: now })
      .where(
        and(
          eq(circularExtractions.status, "processing"),
          sql`${circularExtractions.updatedAt} < ${cutoff}`,
        ),
      )
      .returning({ id: circularExtractions.id });

    if (reaped.length > 0) {
      logger.warn(
        { count: reaped.length },
        "[circulars] returned abandoned extractions to the queue (worker restart)",
      );
    }
    return reaped.length;
  } catch (err) {
    logger.error({ err }, "[circulars] stuck-job reaper failed");
    return 0;
  }
}

// ─── Background loop ─────────────────────────────────────────────────────────

let timer: ReturnType<typeof setInterval> | null = null;

export function startExtractionWorker(intervalMs = pollIntervalMs()): void {
  if (timer) return;

  if (!extractionEnabled()) {
    logger.info(
      "[circulars] AI extraction disabled (CIRCULAR_AI_EXTRACTION=false) — circulars are still ingested, associated and served",
    );
    return;
  }

  // On startup, before the first poll: recover anything a previous process
  // left claimed.
  void reapStuckJobs().catch(() => undefined);

  timer = setInterval(() => {
    void (async () => {
      await reapStuckJobs();
      await processDueExtractions();
    })().catch((err) => logger.error({ err }, "[circulars] extraction tick threw"));
  }, intervalMs);

  if (typeof timer.unref === "function") timer.unref();
  logger.info({ intervalMs, batch: batchSize() }, "[circulars] AI extraction worker started");
}

// The retry rules live in extractionRetry.ts (pure, database-free, testable).
// Re-exported here so the worker remains the single import site for callers.
export { classifyFailure, decideExtractionRetry } from "./extractionRetry.js";
export type { RetryDecision } from "./extractionRetry.js";

export function stopExtractionWorker(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

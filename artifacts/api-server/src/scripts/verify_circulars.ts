/**
 * verify_circulars.ts — database-backed checks for GCN Circular ingestion
 * ---------------------------------------------------------------------------
 * Follows the convention set by verify_dispatcher.ts and
 * verify_wechat_tenant_isolation.ts: the things asserted here are precisely
 * the things a mock would fake.
 *
 *   * a UNIQUE index rejecting a duplicate circular
 *   * a CHECK constraint refusing an attached-but-UNMATCHED row
 *   * a revision creating a second row instead of overwriting the first
 *   * an association resolving against real core.events content
 *   * an extraction row surviving a provider that does not exist
 *
 * Runs against the live database in DATABASE_URL, creates its own fixtures
 * under a reserved circular-id range, and deletes them again — including on
 * failure. It never touches real events or real circulars.
 *
 * Usage (from artifacts/api-server):
 *   tsx src/scripts/verify_circulars.ts
 */

import { and, eq, gte, inArray, lte, sql } from "drizzle-orm";
import {
  db,
  pool,
  eventsTable,
  eventCirculars,
  eventAliases,
  circularExtractions,
  labs,
} from "@workspace/db";

import { ingestCircular, persistCircular, reassociateOrphans } from "../circulars/ingestion.js";
import { associateCircular, seedAliasesForEvent } from "../circulars/association.js";
import { renderingsForEventId } from "../circulars/identity.js";
import { processDueExtractions } from "../circulars/extractionWorker.js";

// Reserved ranges so a bug here can never collide with real GCN data.
// Real circular ids are ~1–45,000; real events never carry this prefix.
const FIXTURE_CIRCULAR_MIN = 900_000_000;
const FIXTURE_CIRCULAR_MAX = 900_000_999;
const FIXTURE_EVENT_PREFIX = "ZZVERIFY";

let passed = 0;
let failed = 0;

function check(label: string, condition: boolean, detail = ""): void {
  if (condition) {
    passed++;
    console.log(`  PASS  ${label}`);
  } else {
    failed++;
    console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ""}`);
  }
}

function section(title: string): void {
  console.log(`\n── ${title} ${"─".repeat(Math.max(0, 68 - title.length))}`);
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

function circular(id: number, overrides: Record<string, unknown> = {}) {
  return {
    circularId: id,
    subject: "Verification circular",
    body: "Fixture body for verify_circulars.ts. Not a real scientific report.",
    submitter: "verify_circulars.ts <noreply@localhost>",
    createdOn: Date.UTC(2026, 0, 15, 12, 0, 0),
    ...overrides,
  };
}

async function cleanup(): Promise<void> {
  // Extractions cascade from circulars; aliases and circulars cascade or
  // SET NULL from events. Order still matters for the SET NULL case.
  await db
    .delete(eventCirculars)
    .where(
      and(
        gte(eventCirculars.circularId, FIXTURE_CIRCULAR_MIN),
        lte(eventCirculars.circularId, FIXTURE_CIRCULAR_MAX),
      ),
    );
  await db.delete(eventsTable).where(sql`${eventsTable.eventId} LIKE ${FIXTURE_EVENT_PREFIX + "%"}`);
  await db.delete(eventAliases).where(sql`${eventAliases.alias} LIKE ${FIXTURE_EVENT_PREFIX + "%"}`);
}

async function main(): Promise<void> {
  console.log("=".repeat(74));
  console.log("  Transient Event Detection — GCN Circular ingestion verification");
  console.log("=".repeat(74));

  await cleanup();

  const [lab] = await db.select().from(labs).limit(1);
  if (!lab) throw new Error("No lab in tenant.labs — cannot run verification.");

  // Two fixture events. The second exists to make an identifier ambiguous.
  const [eventA] = await db
    .insert(eventsTable)
    .values({
      labId: lab.id,
      eventId: `${FIXTURE_EVENT_PREFIX}260115A`,
      eventType: "GRB",
      detectionTime: new Date(Date.UTC(2026, 0, 15, 11, 0, 0)),
      observatory: "Verification",
      source: "bootstrap",
    })
    .returning();
  if (!eventA) throw new Error("fixture event A not created");

  await seedAliasesForEvent(eventA.id, eventA.eventId, [
    ...renderingsForEventId(eventA.eventId),
    `${FIXTURE_EVENT_PREFIX}-ALIAS-260115A`,
  ]);

  // ── 1. Deterministic association ────────────────────────────────────────
  section("1. Deterministic association");

  const exact = await associateCircular({
    eventId: `${FIXTURE_EVENT_PREFIX}260115A`,
    subject: "irrelevant",
    createdOn: new Date(),
  });
  check(
    "EXACT: GCN eventId matching core.events.event_id attaches the circular",
    exact.method === "EXACT" && exact.eventPk === eventA.id,
    `got method=${exact.method} eventPk=${exact.eventPk}`,
  );
  check(
    "EXACT: the lab is inherited from the event, not guessed",
    exact.labId === lab.id,
  );
  check("EXACT: a rationale is recorded", (exact.rationale?.length ?? 0) > 20);

  const caseInsensitive = await associateCircular({
    eventId: `${FIXTURE_EVENT_PREFIX.toLowerCase()}260115a`,
    subject: "irrelevant",
    createdOn: new Date(),
  });
  check(
    "EXACT: matching is case-insensitive (the two ingest paths disagree on case)",
    caseInsensitive.eventPk === eventA.id,
    `got ${caseInsensitive.method}`,
  );

  const alias = await associateCircular({
    eventId: `${FIXTURE_EVENT_PREFIX}-ALIAS-260115A`,
    subject: "irrelevant",
    createdOn: new Date(),
  });
  check(
    "ALIAS: a registered alternate spelling attaches the circular",
    alias.method === "ALIAS" && alias.eventPk === eventA.id,
    `got method=${alias.method}`,
  );

  const unmatched = await associateCircular({
    eventId: "GRB999999Z",
    subject: "An event this archive has never heard of",
    createdOn: new Date(),
  });
  check(
    "UNMATCHED: an unknown identifier does NOT attach to anything",
    unmatched.method === "UNMATCHED" && unmatched.eventPk === null,
    `got method=${unmatched.method}`,
  );
  check(
    "UNMATCHED: the normalized identifier is still recorded, for diagnosis",
    unmatched.normalizedEventId === "GRB999999Z",
  );

  const noIdentifier = await associateCircular({
    eventId: null,
    subject: "General announcement about observing time",
    createdOn: new Date(),
  });
  check(
    "UNMATCHED: a circular naming no event attaches to nothing",
    noIdentifier.method === "UNMATCHED" && noIdentifier.eventPk === null,
    `got method=${noIdentifier.method}`,
  );

  // Ambiguity: register the same alias-shaped identifier against a second
  // event by inserting an event whose canonical id collides on rendering.
  const [eventB] = await db
    .insert(eventsTable)
    .values({
      labId: lab.id,
      eventId: `${FIXTURE_EVENT_PREFIX}260116B`,
      eventType: "GRB",
      detectionTime: new Date(Date.UTC(2026, 0, 16, 11, 0, 0)),
      observatory: "Verification",
      source: "bootstrap",
    })
    .returning();
  if (!eventB) throw new Error("fixture event B not created");

  // Two events reachable by ONE identifier: event A by its canonical id, event
  // B through an alias deliberately pointed at the same string is impossible
  // (the alias index is unique), so ambiguity is produced the only way it can
  // occur in practice — two core.events rows differing only by case.
  const [eventC] = await db
    .insert(eventsTable)
    .values({
      labId: lab.id,
      eventId: `${FIXTURE_EVENT_PREFIX}260115a`, // same string, different case
      eventType: "GRB",
      detectionTime: new Date(Date.UTC(2026, 0, 15, 11, 5, 0)),
      observatory: "Verification",
      source: "bootstrap",
    })
    .returning();

  if (eventC) {
    const ambiguous = await associateCircular({
      eventId: `${FIXTURE_EVENT_PREFIX}260115A`,
      subject: "irrelevant",
      createdOn: new Date(),
    });
    check(
      "PENDING_REVIEW: an identifier matching two events attaches to NEITHER",
      ambiguous.method === "PENDING_REVIEW" && ambiguous.eventPk === null,
      `got method=${ambiguous.method} eventPk=${ambiguous.eventPk}`,
    );
    check(
      "PENDING_REVIEW: a candidate is recorded separately for human review",
      ambiguous.candidateEventPk !== null,
    );
    check(
      "PENDING_REVIEW: the rationale names the competing candidates",
      (ambiguous.rationale ?? "").includes(FIXTURE_EVENT_PREFIX),
    );
    await db.delete(eventsTable).where(eq(eventsTable.id, eventC.id));
  }

  // ── 2. Persistence, idempotency and revisions ───────────────────────────
  section("2. Persistence, idempotency and revisions");

  const first = await persistCircular(
    circular(FIXTURE_CIRCULAR_MIN, {
      eventId: `${FIXTURE_EVENT_PREFIX}260115A`,
      body: "ORIGINAL TEXT: we report a non-detection to R > 21.5 mag.",
    }) as never,
    "archive",
  );
  check("stored: a new circular is inserted", first.isNew && first.circular.version === 1);
  check("stored: it is attached to the right event", first.circular.eventPk === eventA.id);
  check("stored: the original body is preserved verbatim", first.circular.body.startsWith("ORIGINAL TEXT:"));
  check("stored: is_latest is true for the only version", first.circular.isLatest);

  const again = await persistCircular(
    circular(FIXTURE_CIRCULAR_MIN, {
      eventId: `${FIXTURE_EVENT_PREFIX}260115A`,
      body: "ORIGINAL TEXT: we report a non-detection to R > 21.5 mag.",
    }) as never,
    "archive",
  );
  check("idempotent: the same circular twice reports not-new", !again.isNew);

  const [{ count: dupCount } = { count: 0 }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(eventCirculars)
    .where(eq(eventCirculars.circularId, FIXTURE_CIRCULAR_MIN));
  check(
    "idempotent: exactly ONE row exists, enforced by the unique index",
    Number(dupCount) === 1,
    `found ${dupCount} rows`,
  );

  const revision = await persistCircular(
    circular(FIXTURE_CIRCULAR_MIN, {
      eventId: `${FIXTURE_EVENT_PREFIX}260115A`,
      version: 2,
      editedOn: Date.UTC(2026, 0, 16, 9, 0, 0),
      editedBy: "An Editor",
      body: "REVISED TEXT: correcting the limiting magnitude to R > 22.1 mag.",
    }) as never,
    "archive",
  );
  check("revision: version 2 is stored as a NEW row", revision.isNew && revision.isRevision);

  const versions = await db
    .select()
    .from(eventCirculars)
    .where(eq(eventCirculars.circularId, FIXTURE_CIRCULAR_MIN))
    .orderBy(eventCirculars.version);
  check("revision: both versions are retained", versions.length === 2, `found ${versions.length}`);
  check(
    "revision: the ORIGINAL text is not overwritten",
    versions[0]?.body.startsWith("ORIGINAL TEXT:") === true,
    `v1 body = ${versions[0]?.body.slice(0, 40)}`,
  );
  check(
    "revision: only the newest version is is_latest",
    versions[0]?.isLatest === false && versions[1]?.isLatest === true,
    `v1.isLatest=${versions[0]?.isLatest} v2.isLatest=${versions[1]?.isLatest}`,
  );
  check("revision: editor provenance is stored", versions[1]?.editedBy === "An Editor");

  // Out-of-order replay: a version-1 payload arriving after the revision must
  // not steal is_latest back from version 2.
  await persistCircular(
    circular(FIXTURE_CIRCULAR_MIN, {
      eventId: `${FIXTURE_EVENT_PREFIX}260115A`,
      body: "ORIGINAL TEXT: we report a non-detection to R > 21.5 mag.",
    }) as never,
    "archive",
  );
  const afterReplay = await db
    .select()
    .from(eventCirculars)
    .where(eq(eventCirculars.circularId, FIXTURE_CIRCULAR_MIN))
    .orderBy(eventCirculars.version);
  check(
    "revision: an out-of-order v1 replay does not un-latest v2",
    afterReplay[0]?.isLatest === false && afterReplay[1]?.isLatest === true,
    `v1.isLatest=${afterReplay[0]?.isLatest} v2.isLatest=${afterReplay[1]?.isLatest}`,
  );

  // ── 3. The database refuses an inconsistent association ─────────────────
  section("3. Constraints the application cannot talk its way past");

  let constraintHeld = false;
  try {
    await db.execute(sql`
      INSERT INTO core.event_circulars
        (event_pk, lab_id, circular_id, version, subject, body, submitter,
         created_on, association_method, raw_payload, content_hash)
      VALUES
        (${eventA.id}, ${lab.id}, ${FIXTURE_CIRCULAR_MIN + 50}, 1, 's', 'b', 'x',
         now(), 'UNMATCHED', '{}'::jsonb, 'h')
    `);
  } catch {
    constraintHeld = true;
  }
  check(
    "an attached circular cannot claim association_method = UNMATCHED",
    constraintHeld,
    "chk_circular_association_consistent did not fire",
  );

  let labConstraintHeld = false;
  try {
    await db.execute(sql`
      INSERT INTO core.event_circulars
        (event_pk, lab_id, circular_id, version, subject, body, submitter,
         created_on, association_method, raw_payload, content_hash)
      VALUES
        (NULL, ${lab.id}, ${FIXTURE_CIRCULAR_MIN + 51}, 1, 's', 'b', 'x',
         now(), 'UNMATCHED', '{}'::jsonb, 'h')
    `);
  } catch {
    labConstraintHeld = true;
  }
  check(
    "an unattached circular cannot carry a lab (no cross-tenant leak by construction)",
    labConstraintHeld,
    "chk_circular_lab_matches_event did not fire",
  );

  // ── 4. Enrichment is decoupled from the source ──────────────────────────
  section("4. LLM failure cannot lose scientific data");

  // Force a provider that cannot exist, so extraction is guaranteed to fail.
  const savedProvider = process.env["LLM_PROVIDER"];
  const savedKey = process.env["LLM_API_KEY"];
  const savedGeminiKey = process.env["GEMINI_API_KEY"];
  process.env["LLM_PROVIDER"] = "gemini";
  delete process.env["LLM_API_KEY"];
  delete process.env["GEMINI_API_KEY"];

  const unenriched = await ingestCircular(
    circular(FIXTURE_CIRCULAR_MIN + 1, {
      eventId: `${FIXTURE_EVENT_PREFIX}260115A`,
      subject: "A circular ingested while the LLM is unavailable",
    }),
    { source: "archive", modelName: "unconfigured", broadcast: false },
  );
  check(
    "circular is STORED even though no LLM is configured",
    unenriched.isNew && unenriched.circular.eventPk === eventA.id,
  );

  const [queued] = await db
    .select()
    .from(circularExtractions)
    .where(eq(circularExtractions.circularPk, unenriched.circular.id))
    .limit(1);
  check("an extraction job was queued in state pending", queued?.status === "pending");

  await processDueExtractions(10);

  const [afterWorker] = await db
    .select()
    .from(circularExtractions)
    .where(eq(circularExtractions.circularPk, unenriched.circular.id))
    .limit(1);
  check(
    "the worker marks the extraction failed rather than losing it",
    afterWorker?.status === "failed",
    `status=${afterWorker?.status} kind=${afterWorker?.failureKind}`,
  );
  check(
    "a missing key is classified as configuration — never retried forever",
    afterWorker?.failureKind === "configuration",
    `kind=${afterWorker?.failureKind}`,
  );
  check(
    "the failure reason is recorded so the UI is not a blank panel",
    (afterWorker?.lastError?.length ?? 0) > 0,
  );

  const [stillThere] = await db
    .select()
    .from(eventCirculars)
    .where(eq(eventCirculars.id, unenriched.circular.id))
    .limit(1);
  check(
    "THE CIRCULAR IS STILL STORED, ASSOCIATED AND READABLE after the LLM failed",
    stillThere?.body === unenriched.circular.body && stillThere?.eventPk === eventA.id,
  );

  if (savedProvider !== undefined) process.env["LLM_PROVIDER"] = savedProvider;
  if (savedKey !== undefined) process.env["LLM_API_KEY"] = savedKey;
  if (savedGeminiKey !== undefined) process.env["GEMINI_API_KEY"] = savedGeminiKey;

  // ── 5. Extraction caching ───────────────────────────────────────────────
  section("5. The same content is never sent to the same model twice");

  const before = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(circularExtractions)
    .where(eq(circularExtractions.circularPk, unenriched.circular.id));

  await ingestCircular(
    circular(FIXTURE_CIRCULAR_MIN + 1, {
      eventId: `${FIXTURE_EVENT_PREFIX}260115A`,
      subject: "A circular ingested while the LLM is unavailable",
    }),
    { source: "archive", modelName: "unconfigured", broadcast: false },
  );

  const after = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(circularExtractions)
    .where(eq(circularExtractions.circularPk, unenriched.circular.id));

  check(
    "re-ingesting identical content creates no second extraction job",
    Number(before[0]?.count) === Number(after[0]?.count),
    `${before[0]?.count} -> ${after[0]?.count}`,
  );

  // ── 6. Orphan re-association ────────────────────────────────────────────
  section("6. A circular that arrives before its event");

  const orphan = await persistCircular(
    circular(FIXTURE_CIRCULAR_MIN + 2, {
      eventId: `${FIXTURE_EVENT_PREFIX}260117C`,
      subject: "A circular for an event not yet ingested",
    }) as never,
    "archive",
  );
  check("orphan: stored unattached", orphan.circular.eventPk === null && orphan.circular.associationMethod === "UNMATCHED");

  const [lateEvent] = await db
    .insert(eventsTable)
    .values({
      labId: lab.id,
      eventId: `${FIXTURE_EVENT_PREFIX}260117C`,
      eventType: "GRB",
      detectionTime: new Date(Date.UTC(2026, 0, 17, 11, 0, 0)),
      observatory: "Verification",
      source: "kafka",
    })
    .returning();
  if (lateEvent) {
    const attached = await reassociateOrphans(
      lateEvent.id,
      lateEvent.eventId,
      lateEvent.labId,
      renderingsForEventId(lateEvent.eventId),
    );
    check("orphan: attached when the event finally arrives", attached === 1, `attached=${attached}`);

    const [nowAttached] = await db
      .select()
      .from(eventCirculars)
      .where(eq(eventCirculars.id, orphan.circular.id))
      .limit(1);
    check(
      "orphan: the association records that it was resolved later",
      nowAttached?.eventPk === lateEvent.id &&
        (nowAttached?.associationRationale ?? "").includes("Re-associated"),
    );
  }

  // ── Done ────────────────────────────────────────────────────────────────
  await cleanup();

  const leftover = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(eventCirculars)
    .where(
      and(
        gte(eventCirculars.circularId, FIXTURE_CIRCULAR_MIN),
        lte(eventCirculars.circularId, FIXTURE_CIRCULAR_MAX),
      ),
    );
  check("cleanup: no fixture rows remain", Number(leftover[0]?.count) === 0);

  console.log(`\n${"=".repeat(74)}`);
  console.log(`  ${passed} passed, ${failed} failed`);
  console.log("=".repeat(74));

  await pool.end();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error("\nVerification crashed:", err);
  try {
    await cleanup();
  } catch {
    console.error("Cleanup after crash also failed — fixture rows may remain.");
  }
  await pool.end();
  process.exit(1);
});

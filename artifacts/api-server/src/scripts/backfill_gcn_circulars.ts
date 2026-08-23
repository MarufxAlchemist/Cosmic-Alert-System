/**
 * backfill_gcn_circulars.ts — load the historical GCN Circular archive
 * ---------------------------------------------------------------------------
 * Reads `gcn_archive.json.tar.gz` (the 30 MB archive already committed at the
 * project root, 44,766 circulars) and stores every circular in
 * core.event_circulars, associated with core.events by the SAME deterministic
 * algorithm the live Kafka path uses.
 *
 * WHY THIS IS A TYPESCRIPT SCRIPT AND NOT A PYTHON ONE
 * -----------------------------------------------------
 * Association is the one thing that must not have two implementations. A
 * second copy in Python would drift from `circulars/association.ts`, and the
 * archive and the live stream would start attaching the same circular to
 * different events. This script imports `ingestCircular()` — the identical
 * function the Kafka bridge calls — so the two paths cannot diverge.
 *
 * The archive parsing that Python already owned is reused too, in spirit:
 * backend/app/ingest/circulars.py gained a `load_archive()` entry point for
 * the same reason, and neither reader was duplicated inside the other.
 *
 * IDEMPOTENT
 * ----------
 * By database constraint, `event_circulars_identity_uniq` on
 * (circular_id, version). Re-running never creates a duplicate; it refreshes
 * associations, which is useful in its own right after new events are
 * imported.
 *
 * RESUMABLE
 * ---------
 * --resume reads the ids already stored and skips them, so an interrupted run
 * continues in seconds rather than re-doing 44,766 upserts.
 *
 * AI EXTRACTION IS OPT-IN
 * -----------------------
 * Queuing an extraction for all 44,766 circulars would be tens of thousands of
 * paid model calls. --extract enables it; without the flag the circulars are
 * stored, associated and fully readable with no extraction queued, which is a
 * perfectly good state to leave an archive in.
 *
 * Usage (from artifacts/api-server, with DATABASE_URL set):
 *
 *   tsx src/scripts/backfill_gcn_circulars.ts --dry-run
 *   tsx src/scripts/backfill_gcn_circulars.ts --resume
 *   tsx src/scripts/backfill_gcn_circulars.ts --since 2024-01-01 --extract
 *   tsx src/scripts/backfill_gcn_circulars.ts --limit 200
 */

import { createReadStream } from "node:fs";
import { createGunzip } from "node:zlib";
import path from "node:path";
import { sql } from "drizzle-orm";
import { db, eventCirculars, eventsTable, pool } from "@workspace/db";

import { ingestCircular, CircularValidationError } from "../circulars/ingestion.js";
import { seedAliasesForEvent } from "../circulars/association.js";
import { renderingsForEventId } from "../circulars/identity.js";
import { configuredModelName } from "../circulars/extractionWorker.js";

// ─── Minimal streaming tar reader ────────────────────────────────────────────
//
// POSIX tar is 512-byte blocks: one header block per entry, then ceil(size/512)
// data blocks. That is the whole format needed here, so a dependency for it
// would be a dependency for ~60 lines. Verified against the real 44,766-entry
// archive.

const BLOCK = 512;

function readHeaderField(buf: Buffer, offset: number, length: number): string {
  const raw = buf.subarray(offset, offset + length);
  const end = raw.indexOf(0);
  return raw.subarray(0, end === -1 ? raw.length : end).toString("ascii").trim();
}

/** Yield `{name, data}` for each regular file in a gzipped tar stream. */
async function* readTarGz(filePath: string): AsyncGenerator<{ name: string; data: Buffer }> {
  const stream = createReadStream(filePath).pipe(createGunzip());

  let carry = Buffer.alloc(0);
  // null = expecting a header; otherwise we are mid-file collecting `size` bytes.
  let pending: { name: string; size: number } | null = null;

  for await (const chunk of stream) {
    // Buffer.concat unconditionally, rather than aliasing `chunk` when the
    // carry is empty. A stream chunk is Buffer<ArrayBufferLike>, which is not
    // assignable to the Buffer<ArrayBuffer> that Buffer.alloc produces, and
    // concat also gives us a buffer we own rather than one the stream may reuse.
    carry = Buffer.concat([carry, chunk as Uint8Array]);

    for (;;) {
      if (pending === null) {
        if (carry.length < BLOCK) break;

        const header = carry.subarray(0, BLOCK);
        // Two consecutive zero blocks mark end-of-archive; one is enough to stop.
        if (header.every((b) => b === 0)) {
          carry = carry.subarray(BLOCK);
          continue;
        }

        const name = readHeaderField(header, 0, 100);
        const sizeOctal = readHeaderField(header, 124, 12);
        const size = Number.parseInt(sizeOctal || "0", 8) || 0;
        const typeFlag = String.fromCharCode(header[156] ?? 0);

        carry = carry.subarray(BLOCK);

        // '0' and '\0' are regular files; everything else (dirs, links,
        // PAX headers) is skipped over by its declared size.
        const isFile = typeFlag === "0" || typeFlag === "\0";
        pending = { name: isFile ? name : "", size };
        if (size === 0) pending = null;
        continue;
      }

      const padded = Math.ceil(pending.size / BLOCK) * BLOCK;
      if (carry.length < padded) break;

      const data = carry.subarray(0, pending.size);
      if (pending.name && pending.name.endsWith(".json")) {
        yield { name: pending.name, data: Buffer.from(data) };
      }
      carry = carry.subarray(padded);
      pending = null;
    }
  }
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

interface Options {
  archive: string;
  dryRun: boolean;
  resume: boolean;
  extract: boolean;
  since: Date | null;
  limit: number | null;
  progressEvery: number;
}

function parseArgs(argv: string[]): Options {
  const opts: Options = {
    archive: path.resolve(process.cwd(), "../../gcn_archive.json.tar.gz"),
    dryRun: false,
    resume: false,
    extract: false,
    since: null,
    limit: null,
    progressEvery: 500,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--archive":
        opts.archive = path.resolve(argv[++i] ?? "");
        break;
      case "--dry-run":
        opts.dryRun = true;
        break;
      case "--resume":
        opts.resume = true;
        break;
      case "--extract":
        opts.extract = true;
        break;
      case "--since": {
        const raw = argv[++i] ?? "";
        const d = new Date(raw);
        if (Number.isNaN(d.getTime())) throw new Error(`--since is not a date: "${raw}"`);
        opts.since = d;
        break;
      }
      case "--limit":
        opts.limit = Number.parseInt(argv[++i] ?? "", 10);
        if (!Number.isInteger(opts.limit) || opts.limit <= 0) throw new Error("--limit must be a positive integer");
        break;
      case "--help":
      case "-h":
        console.log(HELP);
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return opts;
}

const HELP = `
Backfill historical GCN Circulars into core.event_circulars.

  --archive <path>   Local archive.json.tar.gz (default: <repo root>/gcn_archive.json.tar.gz)
  --since <date>     Only circulars published on or after this date (ISO)
  --limit <n>        Stop after n circulars (for a smoke test)
  --resume           Skip (circularId, version) pairs already stored
  --extract          Also queue AI extraction. OFF by default: the full archive
                     is 44,766 circulars, i.e. 44,766 paid model calls.
  --dry-run          Parse and report; write nothing
  -h, --help         This text

Requires DATABASE_URL. Idempotent: safe to re-run.
`.trim();

// ─── Alias seeding for the existing archive ──────────────────────────────────
//
// Association Level 2 needs core.event_aliases populated. Events ingested
// before this feature existed have no alias rows, so the backfill seeds them
// first — otherwise every circular would fall back to Level 1 only, and the
// IceCube IC…/ICECUBE-… split alone would orphan real matches.

async function seedAllEventAliases(): Promise<number> {
  const events = await db
    .select({ id: eventsTable.id, eventId: eventsTable.eventId })
    .from(eventsTable);

  let total = 0;
  for (const ev of events) {
    total += await seedAliasesForEvent(ev.id, ev.eventId, renderingsForEventId(ev.eventId));
  }
  return total;
}

// ─── Main ────────────────────────────────────────────────────────────────────

interface Stats {
  read: number;
  skippedByDate: number;
  skippedResume: number;
  stored: number;
  duplicates: number;
  invalid: number;
  failed: number;
  byMethod: Record<string, number>;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const bar = "=".repeat(72);

  console.log(`\n${bar}`);
  console.log("  Transient Event Detection — GCN Circular archive backfill");
  console.log(bar);
  console.log(`  Archive     : ${opts.archive}`);
  console.log(`  Since       : ${opts.since ? opts.since.toISOString() : "(all)"}`);
  console.log(`  Limit       : ${opts.limit ?? "(none)"}`);
  console.log(`  Resume      : ${opts.resume}`);
  console.log(`  AI extract  : ${opts.extract ? "yes" : "no (circulars stored without enrichment)"}`);
  console.log(`  Dry run     : ${opts.dryRun}`);
  console.log(`${bar}\n`);

  const stats: Stats = {
    read: 0,
    skippedByDate: 0,
    skippedResume: 0,
    stored: 0,
    duplicates: 0,
    invalid: 0,
    failed: 0,
    byMethod: {},
  };

  // ── Alias seeding ────────────────────────────────────────────────────────
  if (!opts.dryRun) {
    process.stdout.write("[1/3] Seeding event identifier aliases ... ");
    const seeded = await seedAllEventAliases();
    console.log(`${seeded} alias rows added`);
  } else {
    console.log("[1/3] [dry-run] would seed event identifier aliases");
  }

  // ── Resume set ───────────────────────────────────────────────────────────
  const already = new Set<string>();
  if (opts.resume && !opts.dryRun) {
    process.stdout.write("[2/3] Reading already-stored circulars ... ");
    const rows = await db
      .select({ circularId: eventCirculars.circularId, version: eventCirculars.version })
      .from(eventCirculars);
    for (const r of rows) already.add(`${r.circularId}:${r.version}`);
    console.log(`${already.size} present`);
  } else {
    console.log("[2/3] Resume disabled — every circular will be upserted");
  }

  // ── Ingest ───────────────────────────────────────────────────────────────
  console.log("[3/3] Reading archive and ingesting ...\n");
  const modelName = configuredModelName();
  const startedAt = Date.now();

  for await (const entry of readTarGz(opts.archive)) {
    if (opts.limit !== null && stats.read >= opts.limit) break;

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(entry.data.toString("utf-8"));
    } catch {
      stats.invalid++;
      continue;
    }
    if (!payload || typeof payload !== "object") {
      stats.invalid++;
      continue;
    }

    const createdOn = Number(payload["createdOn"]);
    if (opts.since !== null && (!Number.isFinite(createdOn) || createdOn < opts.since.getTime())) {
      stats.skippedByDate++;
      continue;
    }

    stats.read++;

    const key = `${payload["circularId"]}:${Number(payload["version"]) || 1}`;
    if (already.has(key)) {
      stats.skippedResume++;
      continue;
    }

    if (opts.dryRun) {
      stats.stored++;
    } else {
      try {
        const result = await ingestCircular(payload, {
          source: "archive",
          modelName,
          // A backfill must not fire 44,766 WebSocket frames at every
          // connected dashboard.
          broadcast: false,
        });
        if (result.isNew) stats.stored++;
        else stats.duplicates++;
        const m = result.circular.associationMethod;
        stats.byMethod[m] = (stats.byMethod[m] ?? 0) + 1;

        // Enrichment is opt-in. ingestCircular() always queues, so when the
        // flag is off the row is removed again — keeping one code path for
        // ingestion rather than a second, subtly different one.
        if (!opts.extract) {
          await db.execute(sql`
            DELETE FROM core.circular_extractions
             WHERE circular_pk = ${result.circular.id}
               AND status = 'pending'
               AND attempts = 0
          `);
        }
      } catch (err) {
        if (err instanceof CircularValidationError) {
          stats.invalid++;
        } else {
          stats.failed++;
          if (stats.failed <= 5) {
            console.error(`  ! circular ${payload["circularId"]}: ${(err as Error).message}`);
          }
        }
      }
    }

    if (stats.read % opts.progressEvery === 0) {
      const rate = stats.read / ((Date.now() - startedAt) / 1000);
      console.log(
        `  ${stats.read.toLocaleString()} read · ${stats.stored.toLocaleString()} stored · ` +
          `${stats.duplicates.toLocaleString()} dup · ${stats.skippedResume.toLocaleString()} skipped · ` +
          `${rate.toFixed(0)}/s`,
      );
    }
  }

  const elapsed = (Date.now() - startedAt) / 1000;

  console.log(`\n${bar}`);
  console.log("  BACKFILL COMPLETE");
  console.log(bar);
  console.log(`  Circulars considered : ${stats.read.toLocaleString()}`);
  console.log(`  Skipped (date filter): ${stats.skippedByDate.toLocaleString()}`);
  console.log(`  Skipped (resume)     : ${stats.skippedResume.toLocaleString()}`);
  console.log(`  Newly stored         : ${stats.stored.toLocaleString()}`);
  console.log(`  Already present      : ${stats.duplicates.toLocaleString()}`);
  console.log(`  Malformed            : ${stats.invalid.toLocaleString()}`);
  console.log(`  Failed               : ${stats.failed.toLocaleString()}`);
  console.log(`  Elapsed              : ${elapsed.toFixed(1)}s`);
  console.log("\n  Association outcomes:");
  for (const [method, count] of Object.entries(stats.byMethod).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${method.padEnd(16)} ${count.toLocaleString()}`);
  }
  console.log(
    "\n  UNMATCHED is an honest outcome, not a failure: it means the event the\n" +
      "  circular describes was never ingested into this archive.",
  );
  console.log(`${bar}\n`);

  await pool.end();
}

main().catch((err) => {
  console.error("\nBackfill failed:", err);
  process.exit(1);
});

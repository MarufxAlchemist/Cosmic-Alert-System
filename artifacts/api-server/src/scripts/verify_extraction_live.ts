/**
 * verify_extraction_live.ts — one real AI extraction, end to end.
 *
 * Runs the worker against whatever provider LLM_PROVIDER/GEMINI_* selects and
 * reports exactly what happened. Deliberately narrow: it claims a single job,
 * so a misconfiguration costs one call rather than a batch.
 */
import { eq, sql } from "drizzle-orm";
import { db, pool, circularExtractions, eventCirculars } from "@workspace/db";
import { processDueExtractions, configuredModelName } from "../circulars/extractionWorker.js";

async function main() {
  console.log("configured provider:", configuredModelName());

  const [job] = await db
    .select({ id: circularExtractions.id, circularPk: circularExtractions.circularPk })
    .from(circularExtractions)
    .where(eq(circularExtractions.status, "pending"))
    .limit(1);

  if (!job) {
    console.log("No pending extraction jobs.");
    await pool.end();
    return;
  }

  // Re-stamp the job with the real model name so the cache key matches what a
  // configured server would have written.
  await db
    .update(circularExtractions)
    .set({ modelName: configuredModelName() })
    .where(eq(circularExtractions.id, job.id));

  const [circ] = await db
    .select({ circularId: eventCirculars.circularId, subject: eventCirculars.subject })
    .from(eventCirculars)
    .where(eq(eventCirculars.id, job.circularPk))
    .limit(1);
  console.log(`claiming extraction for circular #${circ?.circularId}: ${circ?.subject}`);

  const handled = await processDueExtractions(1);
  console.log("jobs attempted:", handled);

  const [row] = await db
    .select()
    .from(circularExtractions)
    .where(eq(circularExtractions.id, job.id))
    .limit(1);

  console.log("\nstatus       :", row?.status);
  console.log("provider     :", row?.provider);
  console.log("failureKind  :", row?.failureKind);
  console.log("attempts     :", row?.attempts);
  if (row?.lastError) console.log("error        :", row.lastError.slice(0, 300));
  if (row?.extraction) {
    console.log("\n--- validated extraction ---");
    console.log(JSON.stringify(row.extraction, null, 2).slice(0, 2500));
  }

  await pool.end();
}
main().catch(async (e) => { console.error(e); await pool.end(); process.exit(1); });

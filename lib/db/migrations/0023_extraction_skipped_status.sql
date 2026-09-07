-- 0023_extraction_skipped_status.sql
-- Adds 'skipped' to core.circular_extractions.status.
--
-- WHY A FOURTH STATE, RATHER THAN REUSING AN EXISTING ONE
-- ------------------------------------------------------
-- The cost prefilter (CIRCULAR_EXTRACTION_SKIP_NON_SCIENTIFIC) declines to
-- send some routine GRB circulars to the AI provider. That outcome is not
-- any of the states already available, and recording it as one of them would
-- state something untrue:
--
--   'completed' — no. No extraction ran, and chk_extraction_completed_has_
--                 payload rightly demands a payload for that state. A
--                 completed row with no findings reads in the UI as "the AI
--                 read this circular and found nothing", which is a
--                 scientific claim nobody made.
--   'failed'    — no. Nothing went wrong. A failure carries a failure_kind
--                 and an error for a researcher to act on; presenting a
--                 deliberate cost decision as a fault would send someone
--                 debugging a provider that was never called.
--   'pending'   — no. Nothing is coming. A pending row promises a result
--                 that will never arrive, and it would sit in the worker's
--                 due-queue view forever.
--   no row      — no. That is indistinguishable from "not yet queued", which
--                 is the state of every circular in the seconds after
--                 ingestion. The absence of a row cannot say WHY it is
--                 absent, and a silent cost optimisation that leaves no
--                 trace is not auditable.
--
-- So: an explicit row, in an explicit state, that says a deliberate choice
-- was made not to spend a model call here.
--
-- THE due-queue INDEX NEEDS NO CHANGE
-- -----------------------------------
-- circular_extractions_due_idx is partial: WHERE status IN ('pending',
-- 'processing'). A 'skipped' row is therefore invisible to the worker's
-- claim query by construction, not by convention.
--
-- chk_extraction_completed_has_payload ALSO NEEDS NO CHANGE
-- ---------------------------------------------------------
-- It reads `status <> 'completed' OR (extraction IS NOT NULL AND ...)`, so a
-- 'skipped' row with a NULL extraction satisfies it already. Verified against
-- the live constraint definition, not assumed.
--
-- RE-ENABLING EXTRACTION FOR ALREADY-SKIPPED CIRCULARS
-- ----------------------------------------------------
-- A skipped row occupies the (circular_pk, content_hash) cache key, so simply
-- turning the flag off does NOT retroactively queue those circulars —
-- enqueueExtraction's ON CONFLICT DO NOTHING will treat the skip as an answer
-- already held. To backfill them, delete the skip records first:
--
--     DELETE FROM core.circular_extractions WHERE status = 'skipped';
--
-- That is deliberate: the skip is a decision about that exact content, and a
-- content revision produces a new hash and therefore a fresh decision.
--
-- Idempotent: safe to re-run.

DO $$
BEGIN
  -- A CHECK constraint's value list cannot be extended in place; it is
  -- dropped and recreated. Both halves are guarded so a partial previous run
  -- cannot leave the table unconstrained.
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_extraction_status') THEN
    ALTER TABLE core.circular_extractions DROP CONSTRAINT chk_extraction_status;
  END IF;

  ALTER TABLE core.circular_extractions ADD CONSTRAINT chk_extraction_status
    CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'skipped'));
END $$;

COMMENT ON COLUMN core.circular_extractions.status IS
  'pending | processing | completed | failed | skipped. "skipped" means a '
  'deliberate decision was taken not to send this circular to the AI '
  'provider (the CIRCULAR_EXTRACTION_SKIP_NON_SCIENTIFIC cost prefilter) — '
  'NOT that extraction was attempted and produced nothing, and NOT that it '
  'failed. No model call was made.';

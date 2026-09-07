-- 0022_circular_regexp_hints.sql
-- Deterministic regex content triage for GCN Circulars (Priority #5:
-- astro-colibri-circular-parser integration).
--
-- WHY A COLUMN ON core.event_circulars, NOT A ROW IN core.circular_extractions
-- ------------------------------------------------------------------------
-- core.circular_extractions (migration 0019) is documented as "the AI
-- enrichment layer" — a model call, a provider, a prompt version, a schema
-- version, retries. astro-colibri-circular-parser's `build_regexp_hints` is
-- none of that: pure regex over subject+body already sitting in this row,
-- no network call, no model, no cost, and it never fails in a way worth
-- retrying (see backend/app/gcn/circular_hints.py — a failure degrades to
-- null, not to a retryable job). Recording it as an "AI extraction" would
-- misstate what produced it, which this project's own stated principle
-- (deterministic facts vs. AI interpretation must never blur) rules out.
--
-- WHY NULLABLE, NO DEFAULT
-- ------------------------
-- Only the live Kafka path computes hints (in the Python GCN consumer,
-- before the WebSocket broadcast). The historical archive backfill
-- (backend/app/ingest/circulars.py / scripts/backfill_gcn_circulars.ts)
-- does not run that Python step, so its rows have no hints. NULL here means
-- "not computed for this row" — never "the regex found nothing" (an
-- all-false/empty hints object would mean that instead, and is a valid,
-- distinct value from NULL).
--
-- Idempotent: safe to re-run.

ALTER TABLE core.event_circulars
  ADD COLUMN IF NOT EXISTS regexp_hints jsonb;

COMMENT ON COLUMN core.event_circulars.regexp_hints IS
  'Deterministic, offline regex content triage from astro-colibri-circular-'
  'parser''s build_regexp_hints (e.g. likely_redshift_report, matched_terms). '
  'NOT an AI extraction — see core.circular_extractions for that. NULL means '
  'not computed (parser unavailable, or an archive-backfill row), not "no '
  'matches".';

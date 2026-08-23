-- Scientific integrity: retire the last NOT NULL numeric placeholder.
--
-- ROOT CAUSE (two distinct defects on one column)
-- ───────────────────────────────────────────────
-- 1. THE PLACEHOLDER. backend/scripts/import_archive_to_postgres.py:51 contains:
--
--        NULL_LATENCY = 0          # bigint latency_us (still NOT NULL)
--
--    The comment states the reason outright: the column is NOT NULL, so a zero
--    was written in place of a value the importer never had. This is the same
--    pattern migrations 0010 and 0011 removed for the derived sky geometry and
--    the source measurements — latency_us was simply missed. All 279
--    `source='gcn_archive'` rows read "Latency 0 µs" in the UI, which asserts
--    the alert reached the system at the instant of detection.
--
-- 2. THE SEQUENCE DEFAULT (not previously recorded). The column was declared
--    `bigserial` in lib/db/src/schema/events.ts, so it carries:
--
--        DEFAULT nextval('core.events_latency_us_seq')
--
--    latency_us is a MEASUREMENT, not an identity column. Any INSERT that omits
--    it receives 1, 2, 3, … µs — an auto-incrementing counter rendered to the
--    user as a microsecond latency. The sequence is currently unused
--    (is_called = false), so no row carries a counter value yet; this migration
--    removes the landmine before one does.
--
-- WHY THE CHECK PERMITS ZERO
-- ──────────────────────────
-- Zero latency is physically implausible, but the live ingestion paths clamp
-- with max(0, now - detection_time), so a same-instant or clock-skewed notice
-- can still produce 0. A CHECK rejecting zero would fail that INSERT and drop
-- the alert, violating the invariant that validation never drops an alert.
-- Negative latency — an event received before it occurred — is rejected, and
-- is separately reported by validators.py as `latency_negative`.
--
-- WHAT THIS MIGRATION DOES NOT DO
-- ───────────────────────────────
-- It deletes no rows and touches no genuinely measured latency. The 16 `kafka`
-- and 10 `bootstrap` rows are left exactly as they are.

-- ── 1. Remove the sequence default ──────────────────────────────────────────
ALTER TABLE core.events ALTER COLUMN latency_us DROP DEFAULT;
DROP SEQUENCE IF EXISTS core.events_latency_us_seq;

-- ── 2. Allow UNKNOWN to be represented ──────────────────────────────────────
ALTER TABLE core.events ALTER COLUMN latency_us DROP NOT NULL;

COMMENT ON COLUMN core.events.latency_us IS
  'MEASURED ingestion latency (microseconds from detection_time to receipt). NULL = not measurable, e.g. archive imports where the alert was never received live. Never a placeholder.';

-- ── 3. Retire the placeholder ───────────────────────────────────────────────
-- Judged on whether zero is physically meaningful for this quantity, as in
-- migration 0011 — not on a blanket "row looks empty" rule. A latency of
-- exactly 0 µs means the notice arrived at the same instant the event was
-- detected, which no real ingestion path produces (the live minimum on record
-- is 10 000 µs). Every such row is the importer's placeholder.
UPDATE core.events SET latency_us = NULL WHERE latency_us = 0;

-- ── 4. Reject the impossible, allow the merely unknown ──────────────────────
ALTER TABLE core.events
  ADD CONSTRAINT events_latency_us_nonnegative
  CHECK (latency_us IS NULL OR latency_us >= 0);

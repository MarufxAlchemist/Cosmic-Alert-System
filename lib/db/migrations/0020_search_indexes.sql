-- 0020_search_indexes.sql
-- Indexes for the global search palette (events + GCN circulars).
--
-- WHY THIS MIGRATION EXISTS
-- -------------------------
-- Measured on this deployment before any index (305 events, 44,766 circulars):
--
--   core.events.event_id       ILIKE '%260310%'    ~14 ms    tolerable
--   event_circulars.subject    ILIKE '%kilonova%' ~180 ms    sluggish
--   event_circulars.body       ILIKE '%kilonova%' ~1900 ms   unusable
--
-- A search-as-you-type palette fires on every keystroke, so 1.9 s per query is
-- not a slow feature, it is a broken one — and the body text is where the
-- science actually lives, so dropping it from the search was not an option.
--
-- TWO DIFFERENT SEARCHES, TWO DIFFERENT INDEX TYPES
-- -------------------------------------------------
-- Not interchangeable, which is why both are here:
--
--   TRIGRAM (pg_trgm) on identifiers and subjects.
--     Substring queries: "260310" must find GRB260310A, "swift" must find
--     "Swift-BAT". Full-text search cannot do this — it indexes whole
--     lexemes, so a fragment inside a token matches nothing.
--
--   FULL TEXT (tsvector) on subject + body.
--     Word queries with stemming: "kilonova" also finds "kilonovae". Trigram
--     cannot rank by relevance and would match "nova" inside unrelated words.
--
-- WHY A STORED COLUMN AND NOT AN EXPRESSION INDEX
-- -----------------------------------------------
-- The first version of this migration indexed the expression directly. Finding
-- rows was fast, but ranking them was not: ts_rank takes the tsvector as an
-- argument, and with only an expression index Postgres must RECOMPUTE
-- to_tsvector over subject+body for every matching row before it can sort.
--
-- Measured through the API with that design: "kilonova" 0.33 s (few matches),
-- but "swift" 5.4 s and "redshift" 1.4 s — the common words, which are exactly
-- what people type. A generated column stores the vector once, so ts_rank
-- reads it instead of rebuilding it.
--
-- Idempotent: safe to re-run.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ── Identifier and subject substring search ─────────────────────────────────

-- "260310" -> GRB260310A. gin_trgm_ops rather than the btree above it: a btree
-- on event_id serves equality and prefix, never an infix match.
CREATE INDEX IF NOT EXISTS events_event_id_trgm_idx
  ON core.events USING gin (event_id gin_trgm_ops);

CREATE INDEX IF NOT EXISTS events_observatory_trgm_idx
  ON core.events USING gin (observatory gin_trgm_ops);

CREATE INDEX IF NOT EXISTS event_circulars_subject_trgm_idx
  ON core.event_circulars USING gin (subject gin_trgm_ops);

-- The identifier GCN itself published ("GRB 250101A"), so a search for the
-- source's own spelling works as well as for the normalised one.
CREATE INDEX IF NOT EXISTS event_circulars_gcn_event_id_trgm_idx
  ON core.event_circulars USING gin (gcn_event_id gin_trgm_ops)
  WHERE gcn_event_id IS NOT NULL;

-- ── Full-text search over circular content ──────────────────────────────────
--
-- A STORED GENERATED column. to_tsvector with an explicit regconfig is
-- IMMUTABLE, which is what makes it legal here; the one-argument form depends
-- on default_text_search_config, is only STABLE, and is rejected.
--
-- Subject is weighted A and body B, so a circular whose SUBJECT is about
-- kilonovae outranks one that mentions the word once in passing.
--
-- Maintained automatically on INSERT and UPDATE, so the live Kafka path and
-- the archive backfill both stay searchable with no application change.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'core'
       AND table_name   = 'event_circulars'
       AND column_name  = 'search_vector'
  ) THEN
    ALTER TABLE core.event_circulars
      ADD COLUMN search_vector tsvector
        GENERATED ALWAYS AS (
          setweight(to_tsvector('english', coalesce(subject, '')), 'A') ||
          setweight(to_tsvector('english', coalesce(body, '')),    'B')
        ) STORED;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS event_circulars_search_vector_idx
  ON core.event_circulars USING gin (search_vector);

-- Superseded by the stored column above. Dropped so the table does not carry
-- two indexes for the same purpose, one of which cannot serve ranking.
DROP INDEX IF EXISTS core.event_circulars_fts_idx;

COMMENT ON COLUMN core.event_circulars.search_vector IS
  'Weighted full-text vector over subject (A) + body (B), generated and stored '
  'so ts_rank reads it rather than recomputing to_tsvector per row. An '
  'expression index made common queries like "swift" take 5.4 s.';

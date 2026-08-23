-- 0019_gcn_circulars.sql
-- GCN Circular intelligence: human-authored scientific communications attached
-- to the canonical astrophysical event, plus a provenance-preserving AI
-- extraction layer.
--
-- WHY THIS EXISTS
-- ---------------
-- A GCN Notice is a machine-generated rapid alert. A GCN Circular is a
-- human-authored scientific communication that arrives minutes to weeks later
-- and carries the things the Notice never could: follow-up observations,
-- refined localizations, spectroscopy, redshifts, upper limits, corrections.
--
-- Until now the only handling of Circulars in this repository
-- (backend/app/ingest/circulars.py) COLLAPSED a whole group of Circulars into
-- one synthetic event row in a JSON file. The individual scientific
-- communications — who said what, when, about which observation — were
-- discarded. No Circular was ever a first-class record, so the evolving
-- history of an event could not be reconstructed.
--
-- These tables make each Circular a first-class, immutable-by-version record
-- attached to core.events. core.events remains the single canonical event
-- store; nothing here duplicates it.
--
-- Idempotent: safe to re-run.

-- ═══════════════════════════════════════════════════════════════════════════
-- core.event_circulars
-- ═══════════════════════════════════════════════════════════════════════════
--
-- IDENTITY AND REVISIONS
-- ----------------------
-- Verified against the real archive (44,766 circulars): GCN identifies a
-- circular by an integer `circularId`, and a revised circular keeps that id
-- while gaining `version` (2..6 observed), `editedOn` and `editedBy`. An
-- unrevised circular has NO version field at all, which is version 1.
--
-- So identity is the PAIR (circular_id, version). One row per pair means:
--   * re-delivering the same circular is a no-op (unique constraint),
--   * a revision is a NEW row, so the original text is never overwritten,
--   * the full version history is queryable, and `what changed` can be
--     diffed between two rows of the same circular_id.
--
-- ASSOCIATION IS NOT AI
-- ---------------------
-- association_method records HOW the circular was linked to an event. It is
-- decided by deterministic identifier matching, never by a language model.
-- UNMATCHED and PENDING_REVIEW rows keep event_pk NULL: an uncertain
-- association is recorded as uncertain rather than silently attached.

CREATE TABLE IF NOT EXISTS core.event_circulars (
  id                bigserial PRIMARY KEY,

  /* The canonical event this circular describes. NULL means NOT ASSOCIATED —
     either no event identifier was present, no event in this archive matches
     it, or the match was ambiguous. NULL is never "unknown event"; it is
     "this circular is not attached to anything", and the UI must say so.
     ON DELETE SET NULL: deleting an event must not destroy the human-authored
     scientific record that referred to it. */
  event_pk          bigint REFERENCES core.events(id) ON DELETE SET NULL,

  /* Denormalised from the associated event so tenant scoping never needs a
     join. NULL exactly when event_pk is NULL — an unassociated circular
     belongs to no lab and is not served on any lab's event. */
  lab_id            uuid REFERENCES tenant.labs(id),

  /* GCN's own integer identifier, e.g. 35176. */
  circular_id       integer NOT NULL,
  /* 1 for an original circular (GCN omits the field entirely), then 2, 3 … */
  version           integer NOT NULL DEFAULT 1,
  /* True for the highest version of this circular_id. Denormalised so the
     common query ("current text of every circular on this event") is a plain
     index scan rather than a correlated MAX(). */
  is_latest         boolean NOT NULL DEFAULT true,

  /* The eventId string exactly as GCN published it, e.g. "GRB 250101A",
     "LIGO/Virgo S190510g", "IceCube-250302A". Never rewritten: this is the
     source's own words and is what a citation would quote. */
  gcn_event_id      text,
  /* The canonical form derived from gcn_event_id (or from the subject line
     when GCN supplied no eventId), used for matching against
     core.events.event_id. Stored so a failed association can be diagnosed
     without re-running the normaliser. */
  normalized_event_id text,

  subject           text NOT NULL,
  /* The original circular text, verbatim and complete. This is the scientific
     source of record. Nothing downstream — including any AI summary — may
     replace it. */
  body              text NOT NULL,
  /* "text/plain" | "text/markdown". NULL means GCN did not state a format
     (85.7% of the archive); it is NOT an assertion that the body is markdown,
     and the renderer must treat an unstated format as plain text. */
  body_format       text,

  submitter         text NOT NULL,
  submitted_how     text,
  bibcode           text,

  /* Publication time of this circular (GCN createdOn, unix ms). This is when
     the human wrote it — NOT the trigger time of the event. */
  created_on        timestamptz NOT NULL,
  /* Set only on revised circulars. */
  edited_on         timestamptz,
  edited_by         text,

  gcn_url           text,

  /* EXACT | ALIAS | PROBABILISTIC | PENDING_REVIEW | UNMATCHED */
  association_method text NOT NULL DEFAULT 'UNMATCHED',
  /* Human-readable explanation of the decision, including which candidates
     were considered when the answer was PENDING_REVIEW. */
  association_rationale text,
  /* The single best candidate for a PENDING_REVIEW / PROBABILISTIC circular.
     Deliberately a separate column from event_pk: recording a candidate must
     never make the circular show up as an established fact about that event. */
  candidate_event_pk bigint REFERENCES core.events(id) ON DELETE SET NULL,
  associated_at     timestamptz,

  /* The complete original GCN payload, so nothing this schema failed to model
     is lost. */
  raw_payload       jsonb NOT NULL,

  /* SHA-256 over the scientific content (subject + body). Drives the AI
     extraction cache: identical content is never re-sent to a model. */
  content_hash      text NOT NULL,

  /* 'kafka' (live gcn.circulars stream) | 'archive' (historical backfill) */
  source            text NOT NULL DEFAULT 'kafka',

  ingested_at       timestamptz NOT NULL DEFAULT now(),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE core.event_circulars IS
  'Human-authored GCN Circulars, one row per (circular_id, version). The body '
  'is the scientific source of record and is never overwritten by a revision.';
COMMENT ON COLUMN core.event_circulars.event_pk IS
  'Canonical event. NULL means the circular is NOT associated with any event.';
COMMENT ON COLUMN core.event_circulars.association_method IS
  'EXACT | ALIAS | PROBABILISTIC | PENDING_REVIEW | UNMATCHED. Decided by '
  'deterministic identifier matching. A language model never decides this.';
COMMENT ON COLUMN core.event_circulars.body_format IS
  'text/plain | text/markdown. NULL = GCN did not state one; treat as plain.';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_circular_association_method') THEN
    ALTER TABLE core.event_circulars ADD CONSTRAINT chk_circular_association_method
      CHECK (association_method IN
             ('EXACT', 'ALIAS', 'PROBABILISTIC', 'PENDING_REVIEW', 'UNMATCHED'));
  END IF;

  -- An attached circular must say how it was attached, and an unattached one
  -- must not claim it was. This is the constraint that stops a future code
  -- path from quietly linking a circular with method UNMATCHED.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_circular_association_consistent') THEN
    ALTER TABLE core.event_circulars ADD CONSTRAINT chk_circular_association_consistent
      CHECK (
        (event_pk IS NOT NULL AND association_method IN ('EXACT', 'ALIAS', 'PROBABILISTIC'))
        OR
        (event_pk IS NULL AND association_method IN ('PENDING_REVIEW', 'UNMATCHED'))
      );
  END IF;

  -- lab_id is meaningful only for an attached circular.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_circular_lab_matches_event') THEN
    ALTER TABLE core.event_circulars ADD CONSTRAINT chk_circular_lab_matches_event
      CHECK ((event_pk IS NULL) = (lab_id IS NULL));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_circular_version_positive') THEN
    ALTER TABLE core.event_circulars ADD CONSTRAINT chk_circular_version_positive
      CHECK (version >= 1);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_circular_body_format') THEN
    ALTER TABLE core.event_circulars ADD CONSTRAINT chk_circular_body_format
      CHECK (body_format IS NULL OR body_format IN ('text/plain', 'text/markdown'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_circular_source') THEN
    ALTER TABLE core.event_circulars ADD CONSTRAINT chk_circular_source
      CHECK (source IN ('kafka', 'archive'));
  END IF;
END $$;

-- IDEMPOTENCY. The same circular arriving twice — a Kafka redelivery, a
-- re-run of the backfill, a consumer restart replaying offsets — must not
-- create a second scientific record. Enforced by the database, not by an
-- application-level "have I seen this?" check that races with itself.
CREATE UNIQUE INDEX IF NOT EXISTS event_circulars_identity_uniq
  ON core.event_circulars (circular_id, version);

-- The dominant read: every circular on one event, oldest first (a timeline).
CREATE INDEX IF NOT EXISTS event_circulars_event_created_idx
  ON core.event_circulars (event_pk, created_on)
  WHERE event_pk IS NOT NULL;

-- Current text of a circular without a correlated MAX(version).
CREATE INDEX IF NOT EXISTS event_circulars_circular_latest_idx
  ON core.event_circulars (circular_id, is_latest);

-- Re-association sweeps: when a new event lands, which orphaned circulars
-- were waiting for it?
CREATE INDEX IF NOT EXISTS event_circulars_normalized_idx
  ON core.event_circulars (normalized_event_id)
  WHERE normalized_event_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS event_circulars_unassociated_idx
  ON core.event_circulars (association_method, created_on DESC)
  WHERE event_pk IS NULL;

-- Tenant-scoped listing.
CREATE INDEX IF NOT EXISTS event_circulars_lab_created_idx
  ON core.event_circulars (lab_id, created_on DESC)
  WHERE lab_id IS NOT NULL;

-- ═══════════════════════════════════════════════════════════════════════════
-- core.event_aliases
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Alternate renderings of an event's identifier, used by association Level 2.
--
-- These are NOT astrophysical aliases and nothing here asserts that two
-- differently-named events are the same object. Every row is a mechanical
-- re-rendering of one identifier string that different GCN producers write
-- differently — "LIGO/Virgo S190510g" vs "S190510g", "IceCube-250302A" vs
-- "IC250302A" — or an alias supplied explicitly by an operator, recorded with
-- its source so its provenance is auditable.

CREATE TABLE IF NOT EXISTS core.event_aliases (
  id          bigserial PRIMARY KEY,
  event_pk    bigint NOT NULL REFERENCES core.events(id) ON DELETE CASCADE,
  /* Upper-cased, whitespace-stripped alias. */
  alias       text NOT NULL,
  /* CANONICAL   — the event's own event_id
     RENDERING   — a deterministic re-rendering of the canonical id
     OPERATOR    — supplied by a human, with a reason
     Never a value produced by a language model. */
  alias_source text NOT NULL DEFAULT 'RENDERING',
  note        text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE core.event_aliases IS
  'Alternate renderings of an event identifier for deterministic circular '
  'association. Not astrophysical aliases; asserts no physical identity.';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_event_alias_source') THEN
    ALTER TABLE core.event_aliases ADD CONSTRAINT chk_event_alias_source
      CHECK (alias_source IN ('CANONICAL', 'RENDERING', 'OPERATOR'));
  END IF;
END $$;

-- One alias may not point at two events: that would make association
-- ambiguous by construction.
CREATE UNIQUE INDEX IF NOT EXISTS event_aliases_alias_uniq
  ON core.event_aliases (alias);

CREATE INDEX IF NOT EXISTS event_aliases_event_idx
  ON core.event_aliases (event_pk);

-- Case-insensitive lookup of the canonical id itself. The archive importer
-- upper-cased ("ICECUBE-251225A") while the GW parser did not ("S260605a"),
-- so association must compare case-insensitively without a sequential scan.
CREATE INDEX IF NOT EXISTS events_event_id_upper_idx
  ON core.events (UPPER(event_id));

-- ═══════════════════════════════════════════════════════════════════════════
-- core.circular_extractions
-- ═══════════════════════════════════════════════════════════════════════════
--
-- The AI enrichment layer, kept strictly separate from the circular itself.
--
-- THE INVARIANT THIS TABLE ENCODES
-- --------------------------------
-- A language model failing must never lose a scientific source. The circular
-- row is written and associated FIRST; a row here is then created in state
-- 'pending' and worked by a background poller. If the provider is down, the
-- circular is still stored, associated and visible — with its extraction
-- showing 'failed' or 'pending', which is an honest statement about the
-- enrichment, not about the science.
--
-- WHY A TABLE AND NOT A QUEUE SERVER
-- ----------------------------------
-- The same reasoning as alerts.alerts (migration 0018): an in-memory queue
-- loses work on restart. Rows plus `next_attempt_at` plus FOR UPDATE SKIP
-- LOCKED give durability and safe concurrency with no new infrastructure.
--
-- CACHING
-- -------
-- content_hash = SHA-256(subject + body + schema_version + prompt_version +
-- model). Unique per circular row, so the identical circular is never sent to
-- the identical model twice — while a schema, prompt or model upgrade
-- produces a NEW row and the earlier extraction survives as provenance.

CREATE TABLE IF NOT EXISTS core.circular_extractions (
  id             bigserial PRIMARY KEY,
  circular_pk    bigint NOT NULL
                   REFERENCES core.event_circulars(id) ON DELETE CASCADE,

  /* pending | processing | completed | failed */
  status         text NOT NULL DEFAULT 'pending',
  attempts       integer NOT NULL DEFAULT 0,
  /* When this row becomes claimable again. NULL = immediately. */
  next_attempt_at timestamptz,
  /* transient | rate_limit | timeout | invalid_response | configuration.
     Distinguishes "try again later" from "trying again cannot help". */
  failure_kind   text,
  last_error     text,

  /* WHICH model produced this, so a claim can be traced to its author. */
  provider       text,
  model_name     text,
  /* Version of the structured output schema this row conforms to. */
  schema_version integer NOT NULL,
  /* Version of the extraction prompt used. */
  prompt_version integer NOT NULL,
  content_hash   text NOT NULL,

  /* The schema-validated extraction. NULL until status = 'completed'.
     NULL is never rendered as "nothing was observed". */
  extraction     jsonb,
  extracted_at   timestamptz,

  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE core.circular_extractions IS
  'AI-extracted structured information about a circular. An enrichment layer: '
  'its absence or failure never affects the stored circular.';
COMMENT ON COLUMN core.circular_extractions.extraction IS
  'Schema-validated model output. A null field inside it means the circular '
  'did not state the quantity — never that the quantity is zero or absent in '
  'nature.';
COMMENT ON COLUMN core.circular_extractions.content_hash IS
  'SHA-256(subject+body+schema_version+prompt_version+model). Identical '
  'content is never re-sent to the identical model.';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_extraction_status') THEN
    ALTER TABLE core.circular_extractions ADD CONSTRAINT chk_extraction_status
      CHECK (status IN ('pending', 'processing', 'completed', 'failed'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_extraction_failure_kind') THEN
    ALTER TABLE core.circular_extractions ADD CONSTRAINT chk_extraction_failure_kind
      CHECK (failure_kind IS NULL OR failure_kind IN
             ('transient', 'rate_limit', 'timeout', 'invalid_response', 'configuration'));
  END IF;

  -- A completed extraction must actually carry an extraction. Without this a
  -- bug that marks a row complete with a NULL payload would render in the UI
  -- as "AI found nothing in this circular".
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_extraction_completed_has_payload') THEN
    ALTER TABLE core.circular_extractions ADD CONSTRAINT chk_extraction_completed_has_payload
      CHECK (status <> 'completed' OR (extraction IS NOT NULL AND extracted_at IS NOT NULL));
  END IF;
END $$;

-- The cache key, and the idempotency guarantee for the worker.
CREATE UNIQUE INDEX IF NOT EXISTS circular_extractions_cache_uniq
  ON core.circular_extractions (circular_pk, content_hash);

-- The claim query: due work, oldest first.
CREATE INDEX IF NOT EXISTS circular_extractions_due_idx
  ON core.circular_extractions (status, next_attempt_at, created_at)
  WHERE status IN ('pending', 'processing');

CREATE INDEX IF NOT EXISTS circular_extractions_circular_idx
  ON core.circular_extractions (circular_pk, created_at DESC);

-- ═══════════════════════════════════════════════════════════════════════════
-- circular_id must be NUMERIC, not INTEGER
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Found by running the backfill against the real 44,766-circular archive:
-- seven circulars have ids that are not positive integers, and an INTEGER
-- column silently discarded all seven.
--
--   -1, -2, -3, -4, 0   pseudo-ids GCN assigned when 1997 circulars were added
--                       retroactively, below the start of the real sequence.
--                       One of them is "GRB 970228: Keck/LRIS Optical
--                       Observations" — the first GRB with an optical
--                       counterpart.
--   18448.5, 18453.5    fractional ids GCN used to insert a circular between
--                       two that were already numbered.
--
-- These are genuine human-authored scientific reports. Refusing them because
-- their identifier is unusual discards original source material, which this
-- system must never do. NUMERIC stores all seven exactly; the identifier is
-- never arithmetic, so no precision question arises.
--
-- Idempotent: the type change is skipped when it has already been applied.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'core'
       AND table_name   = 'event_circulars'
       AND column_name  = 'circular_id'
       AND data_type    = 'integer'
  ) THEN
    ALTER TABLE core.event_circulars
      ALTER COLUMN circular_id TYPE numeric USING circular_id::numeric;
  END IF;
END $$;

COMMENT ON COLUMN core.event_circulars.circular_id IS
  'GCN''s own circular identifier. NUMERIC, not INTEGER: seven real archived '
  'circulars carry negative, zero or fractional ids. Never used for arithmetic.';

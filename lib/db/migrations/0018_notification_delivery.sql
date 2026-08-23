-- Notification delivery tracking: durable jobs, retry state, idempotency.
--
-- Extends the EXISTING alerts.alerts table rather than adding a parallel job
-- table. That table was already a delivery record (channel, status, payload,
-- response_code, error_message, retry_count, sent_at, delivered_at); it was
-- missing only the fields a retrying dispatcher needs.
--
-- ── DEFECT 1: foreign keys with sequence defaults ───────────────────────────
--
-- alerts.alerts.event_id and .subscription_id were declared `bigserial` in the
-- Drizzle schema, so both carry:
--
--     DEFAULT nextval('alerts.alerts_event_id_seq')
--
-- They are FOREIGN KEYS. An INSERT that omits either one does not fail — it
-- receives 1, 2, 3, … and silently links the delivery to whichever event and
-- whichever subscription happen to hold those ids. That is a delivery
-- attributed to the wrong burst and, worse, to another user's subscription.
--
-- This is the same defect class as latency_us in migration 0017, but here it
-- corrupts referential meaning rather than one displayed value. The table is
-- empty (0 rows), so nothing existing is affected.
--
-- ── DEFECT 2: alerts.notification_history was never created ─────────────────
--
-- Declared in lib/db/src/schema/alerts.ts and written by the deduplication
-- engine's store.ts, and migration 0007 is present in the journal — but the
-- table is absent from this database, so every dedup write silently no-ops
-- and the engine cannot see prior sends. Same failure mode as
-- core.event_correlations in migration 0012. Created idempotently here so
-- environments that already have it are untouched.

-- ── 1. Foreign keys must never auto-generate ────────────────────────────────
ALTER TABLE alerts.alerts ALTER COLUMN event_id        DROP DEFAULT;
ALTER TABLE alerts.alerts ALTER COLUMN subscription_id DROP DEFAULT;
DROP SEQUENCE IF EXISTS alerts.alerts_event_id_seq;
DROP SEQUENCE IF EXISTS alerts.alerts_subscription_id_seq;

COMMENT ON COLUMN alerts.alerts.event_id IS
  'FK to core.events.id. Must be supplied explicitly — never defaulted.';
COMMENT ON COLUMN alerts.alerts.subscription_id IS
  'FK to alerts.alert_subscriptions.id. Must be supplied explicitly.';

-- ── 2. The dedup audit table the engine already writes to ───────────────────
CREATE TABLE IF NOT EXISTS alerts.notification_history (
    id              bigserial PRIMARY KEY,
    event_id        text        NOT NULL,
    lifecycle       text        NOT NULL,
    revision_count  integer     NOT NULL DEFAULT 0,
    priority_level  text        NOT NULL,
    priority_score  integer     NOT NULL DEFAULT 0,
    corr_confidence text        NOT NULL DEFAULT 'NONE',
    error_radius    double precision NOT NULL DEFAULT 0,
    trigger_reasons text[]      NOT NULL DEFAULT '{}',
    suppressed      boolean     NOT NULL DEFAULT false,
    sent_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS notification_history_event_id_sent_at_idx
    ON alerts.notification_history (event_id, sent_at DESC);

-- ── 3. Delivery/retry state ─────────────────────────────────────────────────
ALTER TABLE alerts.alerts
    -- Transport that performed the delivery ('wecom-webhook', 'smtp', ...).
    -- Distinct from `channel`: one channel may have several transports, and
    -- diagnosing a failure needs to know which one ran.
    ADD COLUMN IF NOT EXISTS provider            text,
    ADD COLUMN IF NOT EXISTS last_attempt_at     timestamptz,
    -- When the dispatcher may next pick this row up. NULL = not scheduled.
    ADD COLUMN IF NOT EXISTS next_retry_at       timestamptz,
    -- The provider's own code, kept verbatim (e.g. WeCom errcode 94000).
    -- Text, not integer: not every provider uses numeric codes.
    ADD COLUMN IF NOT EXISTS error_code          text,
    ADD COLUMN IF NOT EXISTS provider_message_id text,
    -- Why the delivery stopped being retried, for the UI to explain itself.
    ADD COLUMN IF NOT EXISTS failure_kind        text,
    ADD COLUMN IF NOT EXISTS idempotency_key     text;

-- ── 4. Duplicate protection, enforced by the database ───────────────────────
-- eventId + revision + subscription + channel. Enforcing this in application
-- code alone is not enough: two dispatcher ticks, or a redelivered Kafka
-- message arriving while the first is in flight, race each other. A UNIQUE
-- index makes the second INSERT fail (or ON CONFLICT DO NOTHING), which is the
-- only place the guarantee actually holds under concurrency.
--
-- Partial, so historical rows without a key do not collide with each other.
CREATE UNIQUE INDEX IF NOT EXISTS alerts_idempotency_key_uniq
    ON alerts.alerts (idempotency_key)
    WHERE idempotency_key IS NOT NULL;

-- ── 5. Status vocabulary ────────────────────────────────────────────────────
-- Pre-existing rows used 'queued'; normalise before constraining.
UPDATE alerts.alerts SET status = 'pending' WHERE status = 'queued';

ALTER TABLE alerts.alerts ALTER COLUMN status SET DEFAULT 'pending';

ALTER TABLE alerts.alerts
    DROP CONSTRAINT IF EXISTS alerts_status_valid;
ALTER TABLE alerts.alerts
    ADD CONSTRAINT alerts_status_valid CHECK (status IN (
        'pending',      -- created, not yet attempted
        'processing',   -- claimed by a dispatcher tick
        'sent',         -- provider accepted it
        'retrying',     -- transient failure, next_retry_at is set
        'failed',       -- permanent failure, or attempts exhausted
        'cancelled'     -- superseded (e.g. a retraction) before delivery
    ));

-- Attempt count must be sane: retry_count is the number of attempts MADE.
ALTER TABLE alerts.alerts
    DROP CONSTRAINT IF EXISTS alerts_retry_count_nonnegative;
ALTER TABLE alerts.alerts
    ADD CONSTRAINT alerts_retry_count_nonnegative CHECK (retry_count >= 0);

-- ── 6. Dispatcher poll index ────────────────────────────────────────────────
-- The dispatcher's hot query is "rows due for work, oldest first". Without
-- this it degenerates to a sequential scan of every delivery ever made.
CREATE INDEX IF NOT EXISTS alerts_due_idx
    ON alerts.alerts (status, next_retry_at)
    WHERE status IN ('pending', 'retrying');

CREATE INDEX IF NOT EXISTS alerts_subscription_created_idx
    ON alerts.alerts (subscription_id, created_at DESC);

-- ── 7. Lifecycle policy per subscription (spec section 19) ──────────────────
-- Which GCN lifecycle stages this subscriber wants. Kept as its own column
-- rather than folded into `behaviour`, which is Record<string, boolean> and
-- has no room for per-stage rules.
--
-- Defaults chosen so a scientifically important revision is never silently
-- discarded: retractions and confirmations always notify, and an update
-- notifies only when the delta engine judged it significant.
ALTER TABLE alerts.alert_subscriptions
    ADD COLUMN IF NOT EXISTS lifecycle_policy jsonb NOT NULL DEFAULT jsonb_build_object(
        'preliminary',        true,
        'initial',            true,
        'update',             'significant_only',
        'confirmed',          true,
        'retraction',         true
    );

COMMENT ON COLUMN alerts.alert_subscriptions.lifecycle_policy IS
  'Per-lifecycle notification rules. "update":"significant_only" defers to the Phase 6 revision delta engine. A retraction always notifies.';

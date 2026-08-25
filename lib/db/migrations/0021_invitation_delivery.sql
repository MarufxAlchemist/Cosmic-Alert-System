-- 0021_invitation_delivery.sql
-- ---------------------------------------------------------------------------
-- Record whether an invitation's email was actually DELIVERED.
--
-- WHY
-- ---
-- POST /team/invitations already inspects the provider result and returns a
-- `delivery` object, and the team page already renders an amber "created but
-- not delivered" panel from it. But that panel lives in React state: it is gone
-- the moment the admin reloads, navigates away, or closes the tab. The Pending
-- Invitations list underneath it showed nothing at all.
--
-- So an invitation that was never mailed looks, one refresh later, exactly like
-- one that was — the invitee is simply waiting for a message that does not
-- exist, and the admin has no way to find out. That is the same class of
-- silent-success bug as the no-op provider returning success:true, one layer
-- further out.
--
-- These columns make the outcome durable, so the list itself can say "not
-- delivered" and offer the link to pass on by hand.
--
-- WHAT THE VALUES MEAN
-- --------------------
--   delivery_status  'sent'        the provider accepted the message
--                    'failed'      a provider was configured and refused it
--                    'skipped'     no provider is configured; nothing was tried
--                    'unknown'     row predates this migration — NOT a claim
--                                  that it was delivered
--   delivery_error   provider error text; NULL when sent
--   delivery_provider  which provider was used ('smtp', 'resend', 'none', …)
--
-- 'unknown' is the default ON PURPOSE. Backfilling existing rows to 'sent'
-- would assert a delivery nobody observed, which is the exact fabrication this
-- schema exists to prevent.
--
-- Idempotent: safe to run against a database that already has it.

ALTER TABLE tenant.lab_invitations
  ADD COLUMN IF NOT EXISTS delivery_status   text NOT NULL DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS delivery_error    text,
  ADD COLUMN IF NOT EXISTS delivery_provider text,
  ADD COLUMN IF NOT EXISTS delivery_at       timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'lab_invitations_delivery_status_check'
  ) THEN
    ALTER TABLE tenant.lab_invitations
      ADD CONSTRAINT lab_invitations_delivery_status_check
      CHECK (delivery_status IN ('sent', 'failed', 'skipped', 'unknown'));
  END IF;
END $$;

-- An error only makes sense for an attempt that failed, and a successful send
-- must not carry one. Enforced rather than trusted, because "sent, with an
-- error attached" is not a state a reader can interpret.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'lab_invitations_delivery_error_check'
  ) THEN
    ALTER TABLE tenant.lab_invitations
      ADD CONSTRAINT lab_invitations_delivery_error_check
      CHECK (delivery_status <> 'sent' OR delivery_error IS NULL);
  END IF;
END $$;

-- Finding the undelivered ones is the whole point, so make that the indexed
-- question rather than a scan of every invitation ever issued.
CREATE INDEX IF NOT EXISTS lab_invitations_undelivered_idx
  ON tenant.lab_invitations (lab_id)
  WHERE status = 'pending' AND delivery_status IN ('failed', 'skipped');

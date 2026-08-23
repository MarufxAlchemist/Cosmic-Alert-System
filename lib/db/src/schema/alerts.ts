import {
  pgSchema,
  bigserial,
  bigint,
  uuid,
  text,
  boolean,
  smallint,
  integer,
  real,
  doublePrecision,
  jsonb,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { labs } from "./tenant.js";
import { users } from "./identity.js";
import { events } from "./events.js";

export const alertsSchema = pgSchema("alerts");

// ─── alerts.notification_history ─────────────────────────────────────────────
//
// Append-only audit table. One row per deduplication decision (send or suppress).
// The engine reads the most-recent sent row for an eventId to detect meaningful
// state changes across GCN lifecycle revisions.
//
// Index: (event_id, sent_at DESC) — used by store.ts getLastNotification()

export const notificationHistory = alertsSchema.table(
  "notification_history",
  {
    id:             bigserial("id", { mode: "bigint" }).primaryKey(),
    /** GCN string event ID (e.g. "S230518h") — not the internal bigserial PK */
    eventId:        text("event_id").notNull(),
    /** GCN lifecycle at decision time: preliminary | initial | update | confirmed */
    lifecycle:      text("lifecycle").notNull(),
    revisionCount:  integer("revision_count").notNull().default(0),
    /** P0 / P1 / P2 / P3 from Phase 5.2 engine */
    priorityLevel:  text("priority_level").notNull(),
    /** 0–100 aggregate score */
    priorityScore:  integer("priority_score").notNull().default(0),
    /** HIGH / MEDIUM / LOW / NONE from Phase 5.4 correlation engine */
    corrConfidence: text("corr_confidence").notNull().default("NONE"),
    /** 1-sigma error radius in arcmin at time of decision */
    errorRadius:    doublePrecision("error_radius").notNull().default(0),
    /**
     * Human-readable reasons why this send/suppress decision was made.
     * e.g. ["First notification", "Priority increased P1→P0"]
     * or   ["Suppressed: no meaningful change since last send"]
     */
    triggerReasons: text("trigger_reasons").array().notNull().default([]),
    /**
     * true  = this revision was suppressed (no email sent)
     * false = email was sent
     */
    suppressed:     boolean("suppressed").notNull().default(false),
    sentAt:         timestamp("sent_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("notification_history_event_id_sent_at_idx").on(t.eventId, t.sentAt),
  ],
);

export type NotificationHistoryRow    = typeof notificationHistory.$inferSelect;
export type InsertNotificationHistory = typeof notificationHistory.$inferInsert;


// ─── alerts.alert_subscriptions ─────────────────────────────────────────────

export const alertSubscriptions = alertsSchema.table("alert_subscriptions", {
  id:               bigserial("id", { mode: "bigint" }).primaryKey(),
  labId:            uuid("lab_id").notNull().references(() => labs.id),
  userId:           uuid("user_id").notNull().references(() => users.id),
  name:             text("name").notNull(),
  eventTypes:       text("event_types").array().notNull().default([]),
  minSnr:           doublePrecision("min_snr"),
  maxFar:           doublePrecision("max_far"),
  minGalLat:        real("min_gal_lat"),
  maxErrorRadius:   real("max_error_radius"),
  observatories:    text("observatories").array().notNull().default([]),
  channel:          text("channel").notNull(),
  channelConfig:    jsonb("channel_config").notNull().$type<Record<string, unknown>>().default({}),
  priorityLevel:    text("priority_level").notNull().default("all"),
  behaviour:        jsonb("behaviour").notNull().$type<Record<string, boolean>>().default({
    aiSummary: true,
    correlation: true,
    localization: true,
    digest: false,
    instant: true,
  }),
  /**
   * Per-lifecycle notification rules (migration 0018).
   * "update": "significant_only" defers to the Phase 6 revision delta engine,
   * so a scientifically meaningful revision is never silently dropped while
   * routine re-issues do not spam. A retraction always notifies.
   */
  lifecyclePolicy:  jsonb("lifecycle_policy").notNull()
    .$type<Record<string, boolean | "significant_only">>()
    .default({
      preliminary: true,
      initial: true,
      update: "significant_only",
      confirmed: true,
      retraction: true,
    }),
  throttleMinutes:  integer("throttle_minutes").notNull().default(0),
  isActive:         boolean("is_active").notNull().default(true),
  createdAt:        timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt:        timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type AlertSubscription = typeof alertSubscriptions.$inferSelect;
export type InsertAlertSubscription = typeof alertSubscriptions.$inferInsert;

// ─── alerts.alerts (TimescaleDB hypertable) ──────────────────────────────────

/** Delivery lifecycle. See migration 0018 for the CHECK constraint. */
export type DeliveryStatus =
  | "pending" | "processing" | "sent" | "retrying" | "failed" | "cancelled";

export const alerts = alertsSchema.table("alerts", {
  id:              bigserial("id", { mode: "bigint" }).primaryKey(),
  labId:           uuid("lab_id").notNull().references(() => labs.id),
  // bigint, NOT bigserial: these are foreign keys. Declared as bigserial they
  // carried a nextval() default, so an INSERT omitting either silently linked
  // the delivery to an arbitrary event and an arbitrary subscription — another
  // user's, potentially. Sequences dropped in migration 0018.
  eventId:         bigint("event_id", { mode: "bigint" }).notNull()
                     .references(() => events.id),
  subscriptionId:  bigint("subscription_id", { mode: "bigint" }).notNull()
                     .references(() => alertSubscriptions.id),
  channel:         text("channel").notNull(),
  status:          text("status").$type<DeliveryStatus>().notNull().default("pending"),
  payload:         jsonb("payload").notNull().$type<Record<string, unknown>>(),
  responseCode:    integer("response_code"),
  errorMessage:    text("error_message"),
  retryCount:      smallint("retry_count").notNull().default(0),
  sentAt:          timestamp("sent_at", { withTimezone: true }),
  deliveredAt:     timestamp("delivered_at", { withTimezone: true }),
  // ── Delivery/retry state (migration 0018) ────────────────────────────────
  /** Transport that ran, e.g. "wecom-webhook". Narrower than `channel`. */
  provider:          text("provider"),
  lastAttemptAt:     timestamp("last_attempt_at", { withTimezone: true }),
  /** When the dispatcher may next claim this row. NULL = not scheduled. */
  nextRetryAt:       timestamp("next_retry_at", { withTimezone: true }),
  /** Provider's own code, verbatim (e.g. WeCom errcode 94000). */
  errorCode:         text("error_code"),
  providerMessageId: text("provider_message_id"),
  /** Failure taxonomy from providers/types.ts, for explaining a dead job. */
  failureKind:       text("failure_kind"),
  /**
   * eventId + revision + subscription + channel. UNIQUE in the database —
   * application-level checks race under concurrent dispatcher ticks.
   */
  idempotencyKey:    text("idempotency_key"),
  createdAt:       timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  // ^ TimescaleDB hypertable partition key — defined via migration:
  //   SELECT create_hypertable('alerts.alerts', 'created_at', chunk_time_interval => INTERVAL '7 days');
});

export type Alert = typeof alerts.$inferSelect;
export type InsertAlert = typeof alerts.$inferInsert;

// ─── Relations ───────────────────────────────────────────────────────────────

export const alertSubscriptionsRelations = relations(alertSubscriptions, ({ one, many }) => ({
  lab:    one(labs, { fields: [alertSubscriptions.labId], references: [labs.id] }),
  user:   one(users, { fields: [alertSubscriptions.userId], references: [users.id] }),
  alerts: many(alerts),
}));

export const alertsRelations = relations(alerts, ({ one }) => ({
  lab:          one(labs, { fields: [alerts.labId], references: [labs.id] }),
  event:        one(events, { fields: [alerts.eventId], references: [events.id] }),
  subscription: one(alertSubscriptions, { fields: [alerts.subscriptionId], references: [alertSubscriptions.id] }),
}));

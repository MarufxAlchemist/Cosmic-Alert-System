import {
  pgSchema,
  uuid,
  text,
  boolean,
  integer,
  bigint,
  bigserial,
  jsonb,
  timestamp,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";

export const tenantSchema = pgSchema("tenant");

// ─── tenant.labs ────────────────────────────────────────────────────────────

export const labs = tenantSchema.table("labs", {
  id:              uuid("id").primaryKey().defaultRandom(),
  slug:            text("slug").notNull().unique(),
  name:            text("name").notNull(),
  plan:            text("plan").notNull().default("free"),
  maxUsers:        integer("max_users").notNull().default(5),
  maxEventsPerDay: integer("max_events_per_day").notNull().default(1000),
  settings:        jsonb("settings").notNull().$type<Record<string, unknown>>().default({}),
  isActive:        boolean("is_active").notNull().default(true),
  createdAt:       timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt:       timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type Lab = typeof labs.$inferSelect;
export type InsertLab = typeof labs.$inferInsert;

// ─── tenant.lab_members ─────────────────────────────────────────────────────

export const labMembers = tenantSchema.table("lab_members", {
  id:       bigserial("id", { mode: "bigint" }).primaryKey(),
  labId:    uuid("lab_id").notNull().references(() => labs.id, { onDelete: "cascade" }),
  userId:   uuid("user_id").notNull(),  // FK to identity.users enforced via migration
  role:     text("role").notNull().default("researcher"),
  joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
});

export type LabMember = typeof labMembers.$inferSelect;
export type InsertLabMember = typeof labMembers.$inferInsert;

// ─── tenant.lab_invitations ─────────────────────────────────────────────────

export const labInvitations = tenantSchema.table("lab_invitations", {
  id:         uuid("id").primaryKey().defaultRandom(),
  labId:      uuid("lab_id").notNull().references(() => labs.id, { onDelete: "cascade" }),
  invitedBy:  uuid("invited_by").notNull(),  // FK to identity.users enforced via migration
  email:      text("email").notNull(),
  role:       text("role").notNull().default("researcher"),
  status:     text("status").notNull().default("pending"),
  expiresAt:  timestamp("expires_at", { withTimezone: true }).notNull(),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }),
  createdAt:  timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),

  // Whether the invitation email actually left the building.
  //
  // 'sent' | 'failed' | 'skipped' | 'unknown'. The default is 'unknown', not
  // 'sent': a row that predates this column records no observation, and
  // claiming delivery nobody witnessed is what made a broken mail setup look
  // like a working one. See migration 0021.
  deliveryStatus:   text("delivery_status").notNull().default("unknown"),
  deliveryError:    text("delivery_error"),
  deliveryProvider: text("delivery_provider"),
  deliveryAt:       timestamp("delivery_at", { withTimezone: true }),
});

export type LabInvitation = typeof labInvitations.$inferSelect;
export type InsertLabInvitation = typeof labInvitations.$inferInsert;

// ─── tenant.event_bookmarks ──────────────────────────────────────────────────
// Cross-schema FK (tenant → core.events) enforced via raw migration SQL.

export const eventBookmarks = tenantSchema.table("event_bookmarks", {
  id:        bigserial("id", { mode: "bigint" }).primaryKey(),
  userId:    uuid("user_id").notNull(),          // FK → identity.users via migration
  labId:     uuid("lab_id").notNull().references(() => labs.id, { onDelete: "cascade" }),
  eventId:   bigint("event_id", { mode: "bigint" }).notNull(), // FK → core.events via migration
  note:      text("note"),                       // optional personal note on the bookmark
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type EventBookmark = typeof eventBookmarks.$inferSelect;
export type InsertEventBookmark = typeof eventBookmarks.$inferInsert;

// ─── Relations ───────────────────────────────────────────────────────────────

export const labsRelations = relations(labs, ({ many }) => ({
  members:     many(labMembers),
  invitations: many(labInvitations),
  bookmarks:   many(eventBookmarks),
}));

export const labMembersRelations = relations(labMembers, ({ one }) => ({
  lab: one(labs, { fields: [labMembers.labId], references: [labs.id] }),
}));

export const labInvitationsRelations = relations(labInvitations, ({ one }) => ({
  lab: one(labs, { fields: [labInvitations.labId], references: [labs.id] }),
}));

export const eventBookmarksRelations = relations(eventBookmarks, ({ one }) => ({
  lab: one(labs, { fields: [eventBookmarks.labId], references: [labs.id] }),
}));


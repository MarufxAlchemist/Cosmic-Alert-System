// ─── Tenant ──────────────────────────────────────────────────────────────────
export {
  tenantSchema,
  labs,
  labMembers,
  labInvitations,
  eventBookmarks,
  labsRelations,
  labMembersRelations,
  labInvitationsRelations,
  eventBookmarksRelations,
} from "./tenant.js";
export type { Lab, InsertLab, LabMember, InsertLabMember, LabInvitation, InsertLabInvitation, EventBookmark, InsertEventBookmark } from "./tenant.js";

// ─── Identity ─────────────────────────────────────────────────────────────────
export {
  identitySchema,
  users,
  sessions,
  apiKeys,
  usersRelations,
  sessionsRelations,
  apiKeysRelations,
} from "./identity.js";
export type { User, InsertUser, Session, InsertSession, ApiKey, InsertApiKey } from "./identity.js";

// ─── Catalog ──────────────────────────────────────────────────────────────────
export {
  catalogSchema,
  observatories,
  observatoryCapabilities,
  skyRegions,
  observatoriesRelations,
  observatoryCapabilitiesRelations,
} from "./catalog.js";
export type {
  Observatory,
  InsertObservatory,
  ObservatoryCapability,
  InsertObservatoryCapability,
  SkyRegion,
  InsertSkyRegion,
} from "./catalog.js";

// ─── Core ─────────────────────────────────────────────────────────────────────
export {
  coreSchema,
  events,
  eventDetections,
  eventLocalizations,
  eventClassifications,
  eventFollowupRequests,
  eventAnnotations,
  eventEmbeddings,
  aiCorrelationAnalysis,
  eventCorrelations,
  eventsRelations,
  eventDetectionsRelations,
  eventLocalizationsRelations,
  eventClassificationsRelations,
  eventFollowupRequestsRelations,
  eventAnnotationsRelations,
  eventEmbeddingsRelations,
  aiCorrelationAnalysisRelations,
  aiScientificSummaries,
  aiScientificSummariesRelations,
  eventValueProvenance,
  eventRevisions,
} from "./events.js";
export type {
  AstroEvent,
  InsertAstroEvent,
  EventDetection,
  InsertEventDetection,
  EventLocalization,
  InsertEventLocalization,
  EventClassification,
  InsertEventClassification,
  EventFollowupRequest,
  InsertEventFollowupRequest,
  EventAnnotation,
  InsertEventAnnotation,
  EventEmbedding,
  InsertEventEmbedding,
  AiCorrelationAnalysis,
  InsertAiCorrelationAnalysis,
  EventCorrelation,
  InsertEventCorrelation,
  EventValueProvenance,
  InsertEventValueProvenance,
  EventRevision,
  InsertEventRevision,
} from "./events.js";
export type {
  AiScientificSummary,
  InsertAiScientificSummary,
} from "./events.js";

// ─── Core: GCN Circulars (migration 0019) ────────────────────────────────────
export {
  eventCirculars,
  eventAliases,
  circularExtractions,
  eventCircularsRelations,
  eventAliasesRelations,
  circularExtractionsRelations,
  CIRCULAR_ASSOCIATION_METHODS,
  CIRCULAR_EXTRACTION_STATUSES,
  CIRCULAR_EXTRACTION_FAILURE_KINDS,
} from "./circulars.js";
export type {
  EventCircular,
  InsertEventCircular,
  EventAlias,
  InsertEventAlias,
  CircularExtraction,
  InsertCircularExtraction,
  CircularAssociationMethod,
  CircularExtractionStatus,
  CircularExtractionFailureKind,
} from "./circulars.js";

// ─── Alerts ───────────────────────────────────────────────────────────────────
export {
  alertsSchema,
  alertSubscriptions,
  alerts,
  notificationHistory,
  alertSubscriptionsRelations,
  alertsRelations,
} from "./alerts.js";
export type {
  AlertSubscription,
  InsertAlertSubscription,
  Alert,
  InsertAlert,
  NotificationHistoryRow,
  InsertNotificationHistory,
} from "./alerts.js";

// ─── Metrics ──────────────────────────────────────────────────────────────────
export {
  metricsSchema,
  eventMetrics,
  eventMetricsRelations,
} from "./metrics.js";
export type { EventMetric, InsertEventMetric } from "./metrics.js";

// ─── Audit ────────────────────────────────────────────────────────────────────
export {
  auditSchema,
  auditLogs,
  auditLogsRelations,
} from "./audit.js";
export type { AuditLog, InsertAuditLog } from "./audit.js";

// ─── Legacy re-exports (maintained for backward-compat) ──────────────────────
// The old users/team_members tables from the public schema are replaced
// by identity.users and tenant.lab_members. Keep the old exports as aliases
// so existing application code doesn't break immediately.
export { users as usersTable } from "./identity.js";
export { events as eventsTable } from "./events.js";

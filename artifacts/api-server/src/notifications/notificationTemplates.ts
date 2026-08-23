/**
 * notificationTemplates.ts
 * ------------------------
 * Public adapter. Bridges the notification pipeline to the Phase 5.3
 * scientific email template system in templates/.
 *
 * This file:
 *   • Defines TemplateInput (accepted by notificationService.ts)
 *   • Delegates entirely to templates/eventTemplate.ts
 *   • Re-exports EmailContent for use by notificationQueue.ts
 *
 * Do NOT put HTML here. All template logic lives in templates/.
 *
 * Phase 5.1 (interface) + Phase 5.3 (template system) + Phase 5.4 (correlation)
 */

import type { NotificationPriority } from "./priorityEngine.js";
import { buildEventEmail }            from "./templates/eventTemplate.js";
import type { CorrelationResult }     from "../science/correlationEngine/index.js";
import type { ScientificSummary }     from "../science/summaryEngine/index.js";

export type { EmailContent }          from "./templates/eventTemplate.js";

// ---------------------------------------------------------------------------
// Input type
// ---------------------------------------------------------------------------

export interface TemplateInput {
  // Core identification
  eventId:            string;
  eventType:          string;
  observatory:        string;
  detectionTime:      string;

  // Lifecycle
  lifecycle:          string;
  alertType?:         string | null;
  classificationTier?: string | null;
  revisionCount:      number;

  // Phase 5.2 classification result (required)
  priorityLevel:      string;
  priorityScore:      number;
  priorityReasons:    string[];
  recommendation:     string;

  // Phase 5.4 correlation result (required — always populated, NONE if no match)
  correlationResult:  CorrelationResult;

  // Phase 5.6 AI scientific summary (optional, may be null if timed out)
  aiSummary:          ScientificSummary | null;

  // Astrometry
  ra:                 number;
  dec:                number;
  errorRadius:        number;

  // Signal quality
  snr:                number;
  far:                number;

  // Type-specific parameters (all optional)
  fluence?:           number | null;
  dm?:                number | null;
  t90?:               number | null;
  chirpMass?:         number | null;
  luminosityDistance?: number | null;

  // Metadata
  /** null = never received live (archive import), so no latency exists. */
  latencyUs:          number | null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build the complete scientific email content for a notification.
 *
 * @param event    - Event data merged with Phase 5.2 + 5.4 results.
 * @param priority - Notification-layer label (CRITICAL / HIGH) from priorityEngine.ts.
 */
export function buildEmailContent(
  event: TemplateInput,
  priority: NotificationPriority,
) {
  return buildEventEmail(
    {
      eventId:            event.eventId,
      eventType:          event.eventType,
      observatory:        event.observatory,
      detectionTime:      event.detectionTime,
      lifecycle:          event.lifecycle,
      alertType:          event.alertType     ?? null,
      classificationTier: event.classificationTier ?? null,
      revisionCount:      event.revisionCount,
      priorityLevel:      event.priorityLevel,
      priorityScore:      event.priorityScore,
      priorityReasons:    event.priorityReasons,
      recommendation:     event.recommendation,
      correlationResult:  event.correlationResult,
      aiSummary:          event.aiSummary,
      ra:                 event.ra,
      dec:                event.dec,
      errorRadius:        event.errorRadius,
      snr:                event.snr,
      far:                event.far,
      fluence:            event.fluence           ?? null,
      dm:                 event.dm               ?? null,
      t90:                event.t90               ?? null,
      chirpMass:          event.chirpMass         ?? null,
      luminosityDistance: event.luminosityDistance ?? null,
      latencyUs:          event.latencyUs,
      generatedAt:        new Date().toISOString(),
      appVersion:         process.env["npm_package_version"] ?? "1.0.0",
    },
    priority,
  );
}

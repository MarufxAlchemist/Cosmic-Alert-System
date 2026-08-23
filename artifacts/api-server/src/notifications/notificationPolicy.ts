/**
 * notificationPolicy.ts
 * ---------------------
 * Who should receive a given event — pure decision logic, no I/O.
 *
 * Deliberately free of any database import. The dispatcher cannot be imported
 * without DATABASE_URL (lib/db throws at module load), which would make these
 * rules untestable without provisioning Postgres. They are the rules most
 * worth testing exhaustively, because a bug here is SILENT: the user simply
 * never hears about a burst and cannot distinguish that from a quiet sky.
 */

export type Priority = "CRITICAL" | "HIGH" | "NORMAL" | "LOW";

export const PRIORITY_RANK: Record<Priority, number> = {
  CRITICAL: 3, HIGH: 2, NORMAL: 1, LOW: 0,
};

/** Maps the P0–P3 vocabulary of the priority engine onto provider priorities. */
export function toPriority(level: string): Priority {
  switch (String(level).toUpperCase()) {
    case "P0": return "CRITICAL";
    case "P1": return "HIGH";
    case "P2": return "NORMAL";
    default:   return "LOW";
  }
}

export interface SubscriptionRules {
  eventTypes: string[];
  observatories: string[];
  priorityLevel: string;
  lifecyclePolicy: Record<string, boolean | "significant_only"> | null;
  isActive: boolean;
}

export interface EventFacts {
  eventType: string;
  observatory: string;
  lifecycle: string;
  isRetraction: boolean;
}

/**
 * Does this subscription want this event?
 *
 * Each rule is one readable condition rather than a combined predicate, so a
 * filtered event can always say which rule excluded it.
 */
export function subscriptionWants(
  sub: SubscriptionRules,
  ev: EventFacts,
  priority: Priority,
): { wanted: boolean; reason?: string } {
  if (!sub.isActive) return { wanted: false, reason: "subscription inactive" };

  // A retraction always goes through. Someone acting on the original alert —
  // pointing a telescope, filing a circular — must be told it was withdrawn,
  // regardless of every other filter.
  if (ev.isRetraction) return { wanted: true };

  if (sub.eventTypes.length && !sub.eventTypes.includes(ev.eventType)) {
    return { wanted: false, reason: `event type ${ev.eventType} not subscribed` };
  }
  if (sub.observatories.length && !sub.observatories.includes(ev.observatory)) {
    return { wanted: false, reason: `observatory ${ev.observatory} not subscribed` };
  }

  const threshold = sub.priorityLevel === "critical_only" ? PRIORITY_RANK.CRITICAL
                  : sub.priorityLevel === "critical_and_high" ? PRIORITY_RANK.HIGH
                  : PRIORITY_RANK.LOW;
  if (PRIORITY_RANK[priority] < threshold) {
    return { wanted: false, reason: `priority ${priority} below ${sub.priorityLevel}` };
  }

  const rule = (sub.lifecyclePolicy ?? {})[ev.lifecycle.toLowerCase()];
  if (rule === false) return { wanted: false, reason: `lifecycle ${ev.lifecycle} disabled` };

  // "significant_only" is already satisfied: the deduplication engine gates
  // this call and only forwards revisions it judged meaningful. Re-deciding it
  // here would be a second implementation of that rule, free to disagree.
  return { wanted: true };
}

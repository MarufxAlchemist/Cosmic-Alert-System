/**
 * alertFilter.ts
 *
 * Scientific quality filter for the GCN Kafka event pipeline.
 * Pure, stateless — no DB access, no I/O.
 *
 * Quality gates per source
 * ------------------------
 * igwn.gwalert
 *   ACCEPT : significant=true, not MDC/mock, not retraction, not engineering
 *   REJECT : RETRACTION, superevent_id starts with "M" or "T" (MDC/test),
 *            significant=false, alert_type=HEARTBEAT or ENGINEERING
 *
 * gcn.notices.icecube.*
 *   ACCEPT : GOLD and BRONZE tier alerts (both kept per mission requirements)
 *   REJECT : is_retraction=true, unknown stream tier, signalness < 0.1
 *
 * gcn.notices.chime.frb
 *   ACCEPT : Real FRB detections (DM > 5 pc/cm³, SNR ≥ 8)
 *   REJECT : msg_type=Retraction/Heartbeat/Test,
 *            DM < 5 (likely galactic RFI), SNR < 8 (low quality)
 *
 * gcn.notices.swift.bat.guano
 *   ACCEPT : ALERT, INITIAL, UPDATE, FINAL with image_significance ≥ 6σ
 *   REJECT : TEST, SUBTHRESH, image_significance < 6σ
 *
 * gcn.notices.einstein_probe.wxt.alert
 *   ACCEPT : Real X-ray transients with SNR ≥ 5
 *   REJECT : TEST, ENGINEERING, UNKNOWN alert_type, SNR < 5
 *
 * gcn.notices.fermi.*
 *   ACCEPT : Real GRB detections (not test, not noise, not sub-threshold)
 *   REJECT : TEST, LIKELY_NOISE, SUBTHRESH, retraction
 */

import type { RejectionCategory } from "./filterReport";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type Lifecycle = "preliminary" | "initial" | "update" | "confirmed";

export type AcceptVerdict = {
  action: "accept";
  lifecycle: Lifecycle;
  alertType: string;
  classificationTier: "GOLD" | "BRONZE" | null;
  observatory: string;
};

export type RejectVerdict = {
  action: "reject";
  reason: string;
  category: RejectionCategory;
};

export type FilterVerdict = AcceptVerdict | RejectVerdict;

// ---------------------------------------------------------------------------
// Scientific quality thresholds
// ---------------------------------------------------------------------------

/**
 * IceCube signalness lower bound.
 * Events with astrophysical neutrino probability below this are noise.
 */
const ICECUBE_MIN_SIGNALNESS = 0.1;

/**
 * CHIME FRB dispersion measure minimum (pc/cm³).
 * Values below this indicate galactic sources / RFI — not extragalactic FRBs.
 */
const CHIME_MIN_DM = 5.0;

/**
 * CHIME FRB SNR minimum.
 * Standard threshold for published CHIME/FRB detections.
 */
const CHIME_MIN_SNR = 8.0;

/**
 * GRB quality thresholds, overridable at runtime.
 *
 * WHY THESE ARE CONFIGURABLE AND NOT DELETED
 * ──────────────────────────────────────────
 * Measured against the live broker, these gates were rejecting NOTHING:
 * 8 GRB notices received, 8 accepted, 0 rejected. They are not the reason a
 * burst fails to appear — the dashboard's lifecycle filter was.
 *
 * They are made configurable so the ceiling can be opened deliberately and
 * reversibly, rather than removed. Setting them to 0 admits everything the
 * instrument reports, INCLUDING sub-threshold triggers that are usually
 * detector noise. That is a legitimate choice for someone who would rather
 * sift noise than miss a marginal burst — but it should be a choice, made
 * once and visible in the environment, not a silent code edit.
 *
 * The test-trigger, retraction and Def_NOT_a_GRB rejections are NOT
 * configurable. Those are not quality thresholds: a TEST packet is not a
 * burst, and a trigger the flight software already attributed to a particle
 * event or a solar flare is not an astrophysical detection. Admitting them
 * would put non-events on the dashboard as bursts.
 */
function envFloat(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * Swift BAT image significance minimum (σ).
 * BAT uses 6.5σ as the canonical detection threshold; 6σ is already inclusive.
 * Set GRB_SWIFT_MIN_IMAGE_SIGNIFICANCE=0 to accept every Swift trigger.
 */
const SWIFT_MIN_IMAGE_SIGNIFICANCE = envFloat("GRB_SWIFT_MIN_IMAGE_SIGNIFICANCE", 6.0);

/**
 * Einstein Probe WXT SNR minimum.
 * Calibration events and noise produce SNR < 5.
 * Set GRB_EP_MIN_SNR=0 to accept every Einstein Probe alert.
 */
const EP_MIN_SNR = envFloat("GRB_EP_MIN_SNR", 5.0);

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function safeStr(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function safeBool(v: unknown, fallback: boolean): boolean {
  if (typeof v === "boolean") return v;
  return fallback;
}

function safeNum(v: unknown, fallback: number): number {
  const n = Number(v);
  return isFinite(n) ? n : fallback;
}

function safeObj(v: unknown): Record<string, unknown> {
  if (v !== null && typeof v === "object" && !Array.isArray(v))
    return v as Record<string, unknown>;
  return {};
}

/** Map a raw GW alert_type string to a normalised Lifecycle value. */
function mapGwLifecycle(alertType: string): Lifecycle {
  switch (alertType.toUpperCase()) {
    case "PRELIMINARY":   return "preliminary";
    case "EARLY_WARNING": return "preliminary";
    case "INITIAL":       return "initial";
    case "UPDATE":        return "update";
    case "CONFIRMED":     return "confirmed";
    default:              return "preliminary";
  }
}

function reject(reason: string, category: RejectionCategory): RejectVerdict {
  return { action: "reject", reason, category };
}

// ---------------------------------------------------------------------------
// Per-source quality filters
// ---------------------------------------------------------------------------

/**
 * IGWN Gravitational Wave Alerts
 *
 * Keep : significant=true, real superevents only
 * Reject:
 *   1. RETRACTION alert_type
 *   2. HEARTBEAT or ENGINEERING alert_type
 *   3. superevent_id starts with "M" → MDC/mock event
 *   4. superevent_id starts with "T" → test superevent injected by pipelines
 *   5. event.significant == false  → sub-threshold candidate
 */
function filterIgwn(topic: string, payload: Record<string, unknown>): FilterVerdict {
  const alertType    = safeStr(payload["alert_type"]).toUpperCase();
  const superEventId = safeStr(payload["superevent_id"]);
  const eventObj     = safeObj(payload["event"]);
  const significant  = safeBool(eventObj["significant"], true);

  if (alertType === "RETRACTION") {
    return reject(
      `GW retraction: alert_type=RETRACTION (superevent_id=${superEventId})`,
      "retraction",
    );
  }

  if (alertType === "HEARTBEAT") {
    return reject(
      `GW heartbeat notice: alert_type=HEARTBEAT`,
      "heartbeat",
    );
  }

  if (alertType === "ENGINEERING") {
    return reject(
      `GW engineering notice: alert_type=ENGINEERING`,
      "engineering",
    );
  }

  // MDC superevents start with "M" — published for developer testing
  if (superEventId.startsWith("M")) {
    return reject(
      `GW MDC/mock event: superevent_id=${superEventId} starts with "M"`,
      "mock_event",
    );
  }

  // Test superevents injected by search pipelines start with "T"
  if (superEventId.startsWith("T")) {
    return reject(
      `GW test injection: superevent_id=${superEventId} starts with "T"`,
      "test_trigger",
    );
  }

  if (!significant) {
    return reject(
      `GW sub-threshold: event.significant=false (superevent_id=${superEventId})`,
      "sub_threshold",
    );
  }

  const preferredEvent = safeObj(payload["preferred_event"]);
  const pipeline       = safeStr(preferredEvent["pipeline"] || payload["pipeline"]) || "LIGO";
  const instruments    = safeStr(preferredEvent["instruments"] || payload["instruments"]);
  const observatory    = instruments ? `LIGO (${instruments})` : pipeline;

  return {
    action:             "accept",
    lifecycle:          mapGwLifecycle(alertType || "PRELIMINARY"),
    alertType:          alertType || "PRELIMINARY",
    classificationTier: null,
    observatory,
  };
}

/**
 * IceCube Neutrino Alerts
 *
 * Keep : GOLD and BRONZE tier alerts with signalness >= 0.1
 * Reject:
 *   1. is_retraction == true
 *   2. stream is not GOLD or BRONZE (unknown tier)
 *   3. signalness < ICECUBE_MIN_SIGNALNESS
 */
function filterIceCube(topic: string, payload: Record<string, unknown>): FilterVerdict {
  const isRetraction = safeBool(payload["is_retraction"], false);

  if (isRetraction) {
    return reject("IceCube retraction: is_retraction=true", "retraction");
  }

  const stream = safeStr(payload["stream"]).toUpperCase();

  if (stream !== "GOLD" && stream !== "BRONZE") {
    return reject(
      `IceCube unknown tier: stream="${safeStr(payload["stream"])}" (expected GOLD or BRONZE)`,
      "low_significance",
    );
  }

  const signalness = safeNum(payload["signalness"], 1.0); // default 1.0 = keep if missing
  if (signalness < ICECUBE_MIN_SIGNALNESS) {
    return reject(
      `IceCube low signalness: ${signalness.toFixed(3)} < ${ICECUBE_MIN_SIGNALNESS} (stream=${stream})`,
      "low_significance",
    );
  }

  const tier: "GOLD" | "BRONZE" = stream === "GOLD" ? "GOLD" : "BRONZE";

  return {
    action:             "accept",
    lifecycle:          "preliminary",
    alertType:          `${tier}_ALERT`,
    classificationTier: tier,
    observatory:        "IceCube",
  };
}

/**
 * CHIME Fast Radio Burst Alerts
 *
 * Keep : Real extragalactic FRB detections (DM > 5, SNR >= 8)
 * Reject:
 *   1. msg_type is Retraction / Heartbeat / Test
 *   2. DM < CHIME_MIN_DM (likely galactic RFI, not a real FRB)
 *   3. SNR < CHIME_MIN_SNR (low quality detection)
 */
function filterChimeFrb(payload: Record<string, unknown>): FilterVerdict {
  const msgType = safeStr(payload["msg_type"] ?? payload["alert_type"]).toUpperCase();

  if (msgType === "RETRACTION") {
    return reject("CHIME FRB retraction: msg_type=Retraction", "retraction");
  }

  if (msgType === "HEARTBEAT") {
    return reject("CHIME heartbeat notice: msg_type=Heartbeat", "heartbeat");
  }

  if (msgType.includes("TEST") || msgType.includes("ENGINEERING")) {
    return reject(`CHIME test/engineering notice: msg_type=${msgType}`, "test_trigger");
  }

  // Quality gate: dispersion measure (extragalactic threshold)
  const dm = safeNum(payload["dm"] ?? payload["DM"], -1);
  if (dm >= 0 && dm < CHIME_MIN_DM) {
    return reject(
      `CHIME FRB low DM: ${dm.toFixed(1)} pc/cm³ < ${CHIME_MIN_DM} (likely galactic / RFI)`,
      "low_significance",
    );
  }

  // Quality gate: signal-to-noise ratio
  const snr = safeNum(payload["snr"] ?? payload["SNR"], 999);
  if (snr < CHIME_MIN_SNR) {
    return reject(
      `CHIME FRB low SNR: ${snr.toFixed(1)} < ${CHIME_MIN_SNR}`,
      "low_significance",
    );
  }

  const tnsName  = safeStr(payload["tns_name"] || payload["event_name"]) || "FRB";
  const alertType = safeStr(payload["msg_type"]) || "DETECTION";

  return {
    action:             "accept",
    lifecycle:          "preliminary",
    alertType:          alertType.toUpperCase() || "DETECTION",
    classificationTier: null,
    observatory:        "CHIME",
  };
}

/**
 * Swift BAT GRB Alerts
 *
 * Keep : ALERT, INITIAL, UPDATE, FINAL with image_significance >= 6σ
 * Reject:
 *   1. trigger_type == TEST
 *   2. trigger_type == SUBTHRESH (sub-threshold, not a confirmed GRB trigger)
 *   3. image_significance < SWIFT_MIN_IMAGE_SIGNIFICANCE
 */
function filterSwift(payload: Record<string, unknown>): FilterVerdict {
  const triggerType = safeStr(payload["trigger_type"]).toUpperCase();

  if (triggerType === "TEST") {
    return reject(`Swift TEST trigger: trigger_type=${triggerType}`, "test_trigger");
  }

  if (triggerType === "SUBTHRESH") {
    return reject(
      `Swift sub-threshold trigger: trigger_type=SUBTHRESH`,
      "sub_threshold",
    );
  }

  // Image significance gate (standard BAT detection threshold is 6.5σ)
  const imgSig = safeNum(payload["image_significance"] ?? payload["ImageSignif"], -1);
  if (imgSig >= 0 && imgSig < SWIFT_MIN_IMAGE_SIGNIFICANCE) {
    return reject(
      `Swift low image significance: ${imgSig.toFixed(1)}σ < ${SWIFT_MIN_IMAGE_SIGNIFICANCE}σ`,
      "low_significance",
    );
  }

  const rawTriggerType = safeStr(payload["trigger_type"]) || "ALERT";
  const instrument     = safeStr(payload["instrument"] ?? payload["Instrument"]) || "BAT";

  let lifecycle: Lifecycle = "preliminary";
  switch (rawTriggerType.toUpperCase()) {
    case "INITIAL":  lifecycle = "initial";   break;
    case "UPDATE":   lifecycle = "update";    break;
    case "FINAL":    lifecycle = "confirmed"; break;
    default:         lifecycle = "preliminary";
  }

  return {
    action:             "accept",
    lifecycle,
    alertType:          rawTriggerType.toUpperCase(),
    classificationTier: null,
    observatory:        `Swift (${instrument})`,
  };
}

/**
 * Einstein Probe WXT X-ray Transient Alerts
 *
 * Keep : High-significance X-ray transients (SNR >= 5, not TEST/ENGINEERING)
 * Reject:
 *   1. trigger_type == TEST or alert_type == TEST
 *   2. alert_type == ENGINEERING
 *   3. alert_type == UNKNOWN (often noise triggers)
 *   4. SNR < EP_MIN_SNR
 */
function filterEinsteinProbe(payload: Record<string, unknown>): FilterVerdict {
  const triggerType = safeStr(payload["trigger_type"]).toUpperCase();
  const alertType   = safeStr(payload["alert_type"]).toUpperCase();

  if (triggerType === "TEST" || alertType === "TEST") {
    return reject(
      `Einstein Probe TEST trigger: trigger_type=${triggerType || alertType}`,
      "test_trigger",
    );
  }

  if (alertType === "ENGINEERING") {
    return reject(
      "Einstein Probe engineering notice: alert_type=ENGINEERING",
      "engineering",
    );
  }

  if (alertType === "UNKNOWN") {
    return reject(
      "Einstein Probe unknown alert_type: likely noise or miscategorised trigger",
      "unknown_format",
    );
  }

  // SNR quality gate
  const snr = safeNum(
    payload["snr"] ?? payload["detection_snr"] ?? payload["net_count_rate"],
    999,
  );
  if (snr < EP_MIN_SNR) {
    return reject(
      `Einstein Probe low significance: SNR/rate=${snr.toFixed(1)} < ${EP_MIN_SNR}`,
      "low_significance",
    );
  }

  const rawAlertType = safeStr(payload["alert_type"]) || "ALERT";

  return {
    action:             "accept",
    lifecycle:          "preliminary",
    alertType:          rawAlertType.toUpperCase(),
    classificationTier: null,
    observatory:        "Einstein Probe (WXT)",
  };
}

/**
 * Fermi GBM / LAT GRB Alerts
 *
 * Keep : Real GRB detections (not test, not noise)
 * Reject:
 *   1. alert_type or trigger_type == TEST
 *   2. classification_type == LIKELY_NOISE (Fermi on-board classification)
 *   3. data_type == TRIGDAT only — less reliable than CTIME/CSPEC/TTE
 *      (only reject TRIGDAT if SNR < threshold, since early TRIGDAT can be valid)
 *   4. Any retraction flag
 */
function filterFermi(payload: Record<string, unknown>): FilterVerdict {
  const alertType        = safeStr(payload["alert_type"] ?? payload["trigger_type"]).toUpperCase();
  const classificationType = safeStr(payload["classification_type"]).toUpperCase();
  const isRetraction     = safeBool(payload["is_retraction"], false);

  if (alertType === "TEST") {
    return reject(`Fermi TEST trigger: alert_type=${alertType}`, "test_trigger");
  }

  if (isRetraction) {
    return reject("Fermi retraction: is_retraction=true", "retraction");
  }

  if (classificationType === "LIKELY_NOISE") {
    return reject(
      "Fermi noise trigger: on-board classification=LIKELY_NOISE",
      "low_significance",
    );
  }

  if (classificationType === "LIKELY_SOFT" && alertType === "SUBTHRESH") {
    return reject(
      "Fermi sub-threshold soft event: LIKELY_SOFT + SUBTHRESH",
      "sub_threshold",
    );
  }

  const rawAlertType = safeStr(payload["alert_type"] ?? payload["trigger_type"]) || "PRELIMINARY";

  return {
    action:             "accept",
    lifecycle:          "preliminary",
    alertType:          rawAlertType.toUpperCase(),
    classificationTier: null,
    observatory:        "Fermi (GBM)",
  };
}

/**
 * Generic fallback — reject unknown formats, accept anything else.
 */
function filterGeneric(topic: string, payload: Record<string, unknown>): FilterVerdict {
  const alertType = safeStr(
    payload["alert_type"] ?? payload["trigger_type"] ?? "PRELIMINARY"
  ).toUpperCase();

  // Catch obvious test/heartbeat patterns in unknown topics
  if (alertType === "TEST" || alertType === "HEARTBEAT") {
    return reject(
      `Generic filter: rejected alert_type=${alertType} from topic=${topic}`,
      alertType === "HEARTBEAT" ? "heartbeat" : "test_trigger",
    );
  }

  return {
    action:             "accept",
    lifecycle:          "preliminary",
    alertType:          safeStr(payload["alert_type"] ?? payload["trigger_type"]) || "PRELIMINARY",
    classificationTier: null,
    observatory:        safeStr(payload["observatory"]) || topic,
  };
}

/**
 * VOEvent GRB streams — Fermi GBM and SVOM.
 *
 * These arrive as XML and are flattened by the Python side into
 * `raw._voevent_doc`, so the JSON-shaped filters above do not apply. Note that
 * `filterFermi()` is unreachable: it keys on the topic prefix
 * "gcn.notices.fermi", which does not exist on the broker — every Fermi stream
 * is published under "gcn.classic.voevent.FERMI_GBM_*".
 *
 * The role / Test_Submission / Def_NOT_a_GRB checks are re-applied here rather
 * than trusted from the Python side: this filter is the documented gate for
 * what reaches the database, and it should not depend on an upstream service
 * having already screened the message.
 */
function filterVoEventGrb(topic: string, payload: Record<string, unknown>): FilterVerdict {
  const doc = safeObj(payload["_voevent_doc"]);
  const params = safeObj(doc["params"]);

  const role = safeStr(doc["role"]).toLowerCase();
  if (role && role !== "observation") {
    return reject(`VOEvent role=${role} is not an observation`, "test_trigger");
  }
  if (safeStr(params["Test_Submission"]).toLowerCase() === "true") {
    return reject("VOEvent Test_Submission=true", "test_trigger");
  }
  if (safeStr(params["Def_NOT_a_GRB"]).toLowerCase() === "true") {
    return reject(
      "Flight software classified the trigger as not a GRB (Def_NOT_a_GRB=true)",
      "not_astrophysical",
    );
  }

  // Fermi re-issues one trigger as its position is refined, coarse to final.
  // Mapping the stage onto the lifecycle lets the revision machinery treat
  // later notices as updates rather than as new bursts.
  let lifecycle: Lifecycle = "preliminary";
  let alertType = "PRELIMINARY";
  if (topic.endsWith("GND_POS")) {
    lifecycle = "update";
    alertType = "UPDATE";
  } else if (topic.endsWith("FIN_POS")) {
    lifecycle = "confirmed";
    alertType = "FINAL";
  }

  let observatory = "Fermi (GBM)";
  if (topic.includes("svom")) {
    observatory = topic.includes("eclairs") ? "SVOM (ECLAIRs)" : "SVOM (GRM)";
    lifecycle = "preliminary";
    alertType = "PRELIMINARY";
  }

  return { action: "accept", lifecycle, alertType, classificationTier: null, observatory };
}

// ---------------------------------------------------------------------------
// Top-level dispatcher
// ---------------------------------------------------------------------------

/**
 * Apply the correct per-source scientific quality filter based on the Kafka topic.
 *
 * @param topic   - Kafka topic string (e.g. "igwn.gwalert", "gcn.notices.chime.frb")
 * @param payload - Parsed JSON payload (raw GCN notice body)
 * @returns FilterVerdict — accept (with lifecycle metadata) or reject (with reason + category)
 */
export function applyAlertFilter(topic: string, payload: unknown): FilterVerdict {
  const p = safeObj(payload);

  if (topic.startsWith("igwn.gwalert")) {
    return filterIgwn(topic, p);
  }

  if (topic.startsWith("gcn.notices.icecube")) {
    return filterIceCube(topic, p);
  }

  if (topic.startsWith("gcn.notices.chime.frb")) {
    return filterChimeFrb(p);
  }

  if (topic.startsWith("gcn.notices.swift")) {
    return filterSwift(p);
  }

  if (topic.startsWith("gcn.notices.einstein_probe")) {
    return filterEinsteinProbe(p);
  }

  if (topic.startsWith("gcn.notices.fermi")) {
    return filterFermi(p);
  }

  // VOEvent XML streams. Must be checked before the generic fallback, which
  // would otherwise accept them with the raw topic string as the observatory.
  if (topic.startsWith("gcn.classic.voevent.FERMI_GBM") ||
      topic.startsWith("gcn.notices.svom.voevent")) {
    return filterVoEventGrb(topic, p);
  }

  return filterGeneric(topic, p);
}

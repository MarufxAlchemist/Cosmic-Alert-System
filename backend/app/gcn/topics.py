from dataclasses import dataclass
from typing import Literal

EventType = Literal["GRB", "GW", "FRB", "NU"]
Priority  = Literal["normal", "high"]


@dataclass(frozen=True)
class TopicMeta:
    event_type:  EventType
    observatory: str
    priority:    Priority


# ── Subscribed topics ────────────────────────────────────────────────────────
#
# Measured against the broker on 2026-08-17 (retained messages per topic):
#
#     gcn.notices.chime.frb                    93   <- the only stream that was
#     igwn.gwalert                           2308      actually producing events
#     gcn.notices.einstein_probe.wxt.alert     14
#     gcn.notices.icecube.gold_bronze...        6
#     gcn.notices.icecube.lvk_nu_track...       0
#     gcn.notices.swift.bat.guano               0   <- ZERO. The only dedicated
#                                                      GRB topic subscribed.
#
# That is why no GRB ever appeared: GUANO is a narrow sub-threshold recovery
# stream and had nothing in retention, Einstein Probe is low-rate, and the
# instrument that actually reports most GRBs — Fermi GBM — was not subscribed
# at all. Its four streams carried 158 notices over the same window, and SVOM
# another 131.
#
# Fermi and SVOM publish VOEvent XML on the gcn.classic.* / *.voevent.*
# families, not JSON. See voevent.py.
TOPICS = [
    # ── FRB ──
    "gcn.notices.chime.frb",
    # ── GW ──
    "igwn.gwalert",
    # ── Neutrino ──
    "gcn.notices.icecube.lvk_nu_track_search",
    "gcn.notices.icecube.gold_bronze_track_alerts",
    # ── GRB: JSON notices ──
    "gcn.notices.einstein_probe.wxt.alert",
    "gcn.notices.swift.bat.guano",
    # ── GRB: Fermi GBM (VOEvent XML) ──
    # Four stages of the same trigger, coarse to refined. All four are
    # subscribed so the event appears immediately and is then revised in
    # place by the existing revision machinery, rather than appearing late.
    #   ALERT   — trigger announcement, no position
    #   FLT_POS — flight-software position, degrees-scale error
    #   GND_POS — ground-recalculated position
    #   FIN_POS — final position
    "gcn.classic.voevent.FERMI_GBM_ALERT",
    "gcn.classic.voevent.FERMI_GBM_FLT_POS",
    "gcn.classic.voevent.FERMI_GBM_GND_POS",
    "gcn.classic.voevent.FERMI_GBM_FIN_POS",
    # ── GRB: SVOM (VOEvent XML) ──
    "gcn.notices.svom.voevent.grm",       # Gamma-Ray Monitor
    "gcn.notices.svom.voevent.eclairs",   # ECLAIRs coded-mask imager
]

# ── GCN Circulars ────────────────────────────────────────────────────────────
#
# `gcn.circulars` carries human-authored scientific communications, NOT machine
# notices. It is kept in its own list, and out of TOPIC_METADATA, on purpose:
#
#   * A circular has no event_type, no observatory and no priority of its own.
#     It is a report ABOUT an event, and the event it belongs to is decided
#     downstream by deterministic identifier matching — not by the topic it
#     arrived on.
#   * TOPIC_METADATA is the notice lookup. A circular reaching get_topic_meta()
#     would be handed the GRB/Unknown/normal fallback and then normalized as if
#     it were a detection, which is exactly the confusion this separation
#     prevents.
#
# Payload shape (verified against the full 44,766-circular archive):
#   circularId:int  subject:str  body:str  submitter:str  createdOn:int(ms)
#   eventId?:str  bibcode?:str  email?:str  submittedHow?:str  format?:str
#   version?:int  editedOn?:int  editedBy?:str
# `version` is ABSENT on an original circular and means 1.
CIRCULAR_TOPICS = [
    "gcn.circulars",
]

# Everything the live consumer subscribes to. Notices and circulars share one
# Kafka connection and one consumer group — a second connection would double
# the broker credentials in play for no benefit.
ALL_TOPICS = TOPICS + CIRCULAR_TOPICS


def is_circular_topic(topic: str) -> bool:
    """True when a message on this topic is a GCN Circular, not a Notice."""
    return topic in CIRCULAR_TOPICS


TOPIC_METADATA: dict[str, TopicMeta] = {
    "gcn.notices.chime.frb": TopicMeta(
        event_type="FRB",
        observatory="CHIME",
        priority="normal",
    ),
    "gcn.notices.einstein_probe.wxt.alert": TopicMeta(
        event_type="GRB",
        observatory="Einstein Probe",
        priority="normal",
    ),
    "gcn.notices.icecube.lvk_nu_track_search": TopicMeta(
        event_type="NU",
        observatory="IceCube",
        priority="normal",
    ),
    "gcn.notices.icecube.gold_bronze_track_alerts": TopicMeta(
        event_type="NU",
        observatory="IceCube",
        priority="high",
    ),
    "igwn.gwalert": TopicMeta(
        event_type="GW",
        observatory="LIGO/Virgo/KAGRA",
        priority="high",
    ),
    "gcn.notices.swift.bat.guano": TopicMeta(
        event_type="GRB",
        observatory="Swift-BAT",
        priority="normal",
    ),
    # ── Fermi GBM ──
    "gcn.classic.voevent.FERMI_GBM_ALERT": TopicMeta(
        event_type="GRB",
        observatory="Fermi-GBM",
        priority="normal",
    ),
    "gcn.classic.voevent.FERMI_GBM_FLT_POS": TopicMeta(
        event_type="GRB",
        observatory="Fermi-GBM",
        priority="normal",
    ),
    "gcn.classic.voevent.FERMI_GBM_GND_POS": TopicMeta(
        event_type="GRB",
        observatory="Fermi-GBM",
        priority="normal",
    ),
    "gcn.classic.voevent.FERMI_GBM_FIN_POS": TopicMeta(
        event_type="GRB",
        observatory="Fermi-GBM",
        priority="high",
    ),
    # ── SVOM ──
    "gcn.notices.svom.voevent.grm": TopicMeta(
        event_type="GRB",
        observatory="SVOM-GRM",
        priority="normal",
    ),
    "gcn.notices.svom.voevent.eclairs": TopicMeta(
        event_type="GRB",
        observatory="SVOM-ECLAIRs",
        priority="normal",
    ),
}


def get_topic_meta(topic: str) -> TopicMeta:
    """Return metadata for a topic, falling back to safe defaults."""
    return TOPIC_METADATA.get(
        topic,
        TopicMeta(event_type="GRB", observatory="Unknown", priority="normal"),
    )
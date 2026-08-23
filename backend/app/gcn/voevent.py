"""
voevent.py
----------
Flatten a VOEvent 2.0 XML document into a plain dict.

WHY THIS EXISTS
───────────────
The GCN Kafka broker carries 276 topics in three encodings. Only the
`gcn.notices.*` family is JSON; the entire `gcn.classic.*` family — which
includes every Fermi GBM stream — is VOEvent XML, plain text or a binary
packet. The consumer decoded messages with json.loads() and fell back to
{"raw_text": ...} on failure, so an XML notice normalized to an event with no
position, no time and no significance.

That is why no Fermi GRB ever reached the dashboard: the only subscribed GRB
topics were Einstein Probe (JSON, low rate) and Swift-BAT GUANO, which had
ZERO retained messages on the broker. Meanwhile the Fermi GBM topics carried
158 notices across FLT/GND/FIN/ALERT, and SVOM another 131.

WHAT IS EXTRACTED
─────────────────
VOEvent puts the measurement in two places, and both are needed:

  <What>      a flat list of <Param name= value=>, some nested in <Group>.
              Instrument-specific: TrigID, Data_Signif, the Trigger_ID flags.

  <WhereWhen> the IVOA-standard position and time, identical in structure
              across every mission that emits VOEvent. This is where RA, Dec,
              Error2Radius and ISOTime live.

UNITS
─────
Position2D declares its own unit attribute (deg in every GCN stream observed).
Error2Radius is in THOSE units, so it is returned as degrees and converted to
arcmin by the caller — `errorRadius` is arcmin everywhere in this codebase and
a 27.9 deg flight localization stored as 27.9 arcmin would claim a position
60x better than the notice reported.
"""

from __future__ import annotations

import re
from typing import Any
from xml.etree import ElementTree as ET

#: A message whose role is not an observation is not a detection. GCN emits
#: `test` and `utility` roles on the same topics as real alerts.
OBSERVATION_ROLE = "observation"


def _localname(tag: str) -> str:
    """Strip the XML namespace: '{http://...}Param' -> 'Param'."""
    return tag.rsplit("}", 1)[-1] if "}" in tag else tag


def _find(node: ET.Element, *path: str) -> ET.Element | None:
    """Namespace-agnostic descent by local element name."""
    cur: ET.Element | None = node
    for want in path:
        if cur is None:
            return None
        cur = next((c for c in cur if _localname(c.tag) == want), None)
    return cur


def _text(node: ET.Element | None) -> str | None:
    if node is None or node.text is None:
        return None
    s = node.text.strip()
    return s or None


def _num(v: Any) -> float | None:
    if v is None:
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if f == f and abs(f) != float("inf") else None


def looks_like_voevent(text: str) -> bool:
    """Cheap sniff so the consumer can route without a full parse."""
    if not text:
        return False
    head = text.lstrip()[:400].lower()
    return head.startswith("<?xml") or "<voe:voevent" in head or "<voevent" in head


def parse(xml_text: str) -> dict[str, Any] | None:
    """
    Return a flat dict, or None if the document is not parseable VOEvent.

    Never raises: a malformed notice must degrade to "unparsed" rather than
    take down the listener.
    """
    if not xml_text:
        return None
    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError:
        return None
    if _localname(root.tag) != "VOEvent":
        return None

    params: dict[str, str] = {}
    groups: dict[str, dict[str, str]] = {}

    what = _find(root, "What")
    if what is not None:
        for child in what:
            name = _localname(child.tag)
            if name == "Param":
                pname = child.get("name")
                if pname:
                    params[pname] = child.get("value", "")
            elif name == "Group":
                gname = child.get("name") or ""
                g: dict[str, str] = {}
                for p in child:
                    if _localname(p.tag) == "Param" and p.get("name"):
                        g[p.get("name")] = p.get("value", "")
                        # Flatten too, so callers need not know the grouping.
                        params.setdefault(p.get("name"), p.get("value", ""))
                if gname:
                    groups[gname] = g

    coords = _find(root, "WhereWhen", "ObsDataLocation",
                   "ObservationLocation", "AstroCoords")
    iso_time = ra = dec = err = None
    pos_unit = "deg"
    if coords is not None:
        iso_time = _text(_find(coords, "Time", "TimeInstant", "ISOTime"))
        pos = _find(coords, "Position2D")
        if pos is not None:
            pos_unit = pos.get("unit") or "deg"
            val = _find(pos, "Value2")
            if val is not None:
                ra = _num(_text(_find(val, "C1")))
                dec = _num(_text(_find(val, "C2")))
            err = _num(_text(_find(pos, "Error2Radius")))

    return {
        "_voevent": True,
        "role": (root.get("role") or "").lower(),
        "ivorn": root.get("ivorn") or "",
        "iso_time": iso_time,
        "ra": ra,
        "dec": dec,
        # In `pos_unit` (deg for every GCN stream observed). The caller
        # converts; this layer does not guess.
        "error_radius": err,
        "position_unit": pos_unit,
        "params": params,
        "groups": groups,
    }


def is_observation(doc: dict[str, Any]) -> bool:
    """
    True only for a real detection.

    Rejects the `test`/`utility` roles, GCN's own Test_Submission flag, and
    Def_NOT_a_GRB — a Fermi trigger the flight software has already attributed
    to a particle event, solar flare or known source. Ingesting those would
    put non-astrophysical triggers on the dashboard as bursts.
    """
    if doc.get("role") != OBSERVATION_ROLE:
        return False
    p = doc.get("params") or {}
    if str(p.get("Test_Submission", "")).lower() == "true":
        return False
    if str(p.get("Def_NOT_a_GRB", "")).lower() == "true":
        return False
    return True


#: Fermi GBM names its data products bnYYMMDDfff. The IVORN carries the same
#: identity and is the only stable per-notice string when TrigID is absent.
_IVORN_TAIL = re.compile(r"#(.+)$")


def ivorn_tail(ivorn: str) -> str | None:
    m = _IVORN_TAIL.search(ivorn or "")
    return m.group(1) if m else None

"""
circulars.py
------------
Production-grade ingest pipeline for GCN Circulars.

Workflow
--------
1.  Download ``archive.json.tar.gz`` from ``gcn.nasa.gov`` (≈30 MB).
2.  Decompress in-memory and parse the JSON array of circulars.
3.  Filter to the last *N* days (default 120).
4.  Extract a canonical event name from each circular's ``eventId`` field
    (provided by GCN since ≈v6) or fall back to regex against the
    ``subject`` line (handles legacy circulars and edge cases).
5.  Group circulars by canonical event name.
6.  Build a timeline for every event (earliest → latest circular).
7.  Extract RA, Dec, and error radius from the *body* text of the
    earliest positional circular for each event.
8.  Emit one AstroEvent-schema dict per event.
9.  Deduplicate against an existing ``historical_events.json`` and write
    the merged result back.

Usage (from ``backend/``)::

    python -m app.ingest.circulars
    python -m app.ingest.circulars --days 90 --dry-run
"""

from __future__ import annotations

import argparse
import gzip
import io
import json
import math
import re
import sys
import tarfile
import uuid
import urllib.request
import urllib.error
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Any

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

BACKEND_DIR  = Path(__file__).resolve().parent.parent.parent   # backend/
PROJECT_ROOT = BACKEND_DIR.parent
HISTORY_JSON = PROJECT_ROOT / "historical_events.json"

# ---------------------------------------------------------------------------
# GCN archive URL
# ---------------------------------------------------------------------------

ARCHIVE_URL = "https://gcn.nasa.gov/circulars/archive.json.tar.gz"

# How long to wait for the download (seconds).
DOWNLOAD_TIMEOUT_S = 120

# ---------------------------------------------------------------------------
# Event-name extraction
# ---------------------------------------------------------------------------

# Patterns ordered by specificity.  First match wins.
# Each pattern captures the canonical event name into group(0) of the
# *first* capturing group.
_EVENT_PATTERNS: list[tuple[re.Pattern, str]] = [
    # GRB YYMMDDX  (e.g. GRB 250531A, GRB250531A, GRB 250531)
    (re.compile(r"\bGRB\s*(\d{6}[A-Z]?)\b", re.I), "GRB"),
    # LVK/IGWN superevent  S + 6 digits + letter(s)  (e.g. S230518h, S250601ab)
    (re.compile(r"\b(S\d{6}[a-z]+)\b", re.I), "GW"),
    # GW YYMMDD + optional letter  (e.g. GW 230529ay, GW230529)
    (re.compile(r"\bGW\s*(\d{6}[a-z]*)\b", re.I), "GW"),
    # FRB YYMMDD + optional letter  (e.g. FRB 20250101A)
    (re.compile(r"\bFRB\s*(\d{6,8}[A-Z]?)\b", re.I), "FRB"),
    # IceCube event  IC + YYMMDD + letter (or IceCube-YYMMDD)
    (re.compile(r"\b(?:IC|IceCube)[- ]?(\d{6}[A-Z]?)\b", re.I), "NU"),
    # EP transient  EP + Tnnn…   (Einstein Probe)
    (re.compile(r"\b(EP\s*T\d+)\b", re.I), "GRB"),
]


def _classify_event_name(raw_name: str) -> tuple[str, str]:
    """
    Return ``(canonical_name, event_type)`` for a raw event identifier.

    ``raw_name`` can be the ``eventId`` field from the GCN archive, or a
    subject line.  Whitespace inside the name is normalised away so that
    both ``GRB 250531A`` and ``GRB250531A`` yield the same canonical key.
    """
    for pattern, etype in _EVENT_PATTERNS:
        m = pattern.search(raw_name)
        if m:
            # Build a clean canonical name:  TYPE + captured digits+letters
            suffix = m.group(1) if m.lastindex else m.group(0)
            # Normalise: strip internal spaces, uppercase the suffix
            suffix = suffix.replace(" ", "").upper()
            canonical = f"{etype}{suffix}" if not suffix.upper().startswith(etype) else suffix.upper()
            # Ensure GRB/GW prefix is always present
            if etype == "GRB" and not canonical.startswith("GRB"):
                canonical = f"GRB{canonical}"
            if etype == "GW" and not canonical.startswith(("GW", "S")):
                canonical = f"GW{canonical}"
            if etype == "FRB" and not canonical.startswith("FRB"):
                canonical = f"FRB{canonical}"
            if etype == "NU" and not canonical.startswith(("IC", "NU")):
                canonical = f"IC{canonical}"
            return canonical, etype
    return raw_name.strip(), "GRB"   # unknown → default to GRB


def _observatory_for(event_type: str, subject: str) -> str:
    """Infer observatory from event type and subject keywords."""
    subj = subject.lower()
    if event_type == "GW":
        return "LIGO/Virgo/KAGRA"
    if event_type == "FRB":
        if "chime" in subj:
            return "CHIME"
        return "CHIME"           # CHIME dominates circular FRBs
    if event_type == "NU":
        return "IceCube"
    # GRB: try to identify the instrument
    for kw, obs in [
        ("swift",    "Swift-BAT"),
        ("bat",      "Swift-BAT"),
        ("fermi",    "Fermi-GBM"),
        ("gbm",      "Fermi-GBM"),
        ("lat",      "Fermi-LAT"),
        ("einstein", "Einstein Probe"),
        ("ep-wxt",   "Einstein Probe"),
        ("maxi",     "MAXI"),
        ("integral", "INTEGRAL"),
        ("konus",    "Konus-Wind"),
        ("agile",    "AGILE"),
        ("calet",    "CALET"),
    ]:
        if kw in subj:
            return obs
    return "Multi-Mission"


# ---------------------------------------------------------------------------
# Coordinate extraction from circular body text
# ---------------------------------------------------------------------------

# RA patterns — covers HH:MM:SS.s, HH MM SS.s, and decimal degrees
_RA_HMS = re.compile(
    r"(?:RA|R\.?A\.?|Right\s+Ascension)"
    r"[\s(:=]*"
    r"(\d{1,3})[h:\s]+(\d{1,2})[m:\s]+(\d{1,2}(?:\.\d+)?)"
    r"\s*(?:s|sec)?",
    re.I,
)
_RA_DEG = re.compile(
    r"(?:RA|R\.?A\.?)"
    r"[\s(:=]*"
    r"([+-]?\d{1,3}\.\d+)\s*(?:deg|d|°)",
    re.I,
)

# Dec patterns — covers ±DD:MM:SS.s, ±DD MM SS.s, and decimal degrees
_DEC_DMS = re.compile(
    r"(?:Dec|Decl?\.?|Declination)"
    r"[\s(:=]*"
    r"([+-]?\d{1,3})[d°:\s]+(\d{1,2})['m:\s]+(\d{1,2}(?:\.\d+)?)"
    r'["\s]*(?:s|sec|arcsec)?',
    re.I,
)
_DEC_DEG = re.compile(
    r"(?:Dec|Decl?\.?)"
    r"[\s(:=]*"
    r"([+-]?\d{1,3}\.\d+)\s*(?:deg|d|°)",
    re.I,
)

# Error radius — arcmin or arcsec
_ERR_ARCMIN = re.compile(
    r"(?:error|uncertainty|radius|locali[sz]ation)"
    r"[\s:]*(?:radius)?[\s:]*(?:of\s+)?"
    r"(?:~|≈|about\s+|approx\.?\s+)?"
    r"(\d+(?:\.\d+)?)\s*(?:arcmin(?:ute)?s?|')",
    re.I,
)
_ERR_ARCSEC = re.compile(
    r"(?:error|uncertainty|radius|locali[sz]ation)"
    r"[\s:]*(?:radius)?[\s:]*(?:of\s+)?"
    r"(?:~|≈|about\s+|approx\.?\s+)?"
    r'(\d+(?:\.\d+)?)\s*(?:arcsec(?:ond)?s?|")',
    re.I,
)
_ERR_DEG = re.compile(
    r"(?:error|uncertainty|radius|locali[sz]ation)"
    r"[\s:]*(?:radius)?[\s:]*(?:of\s+)?"
    r"(?:~|≈|about\s+|approx\.?\s+)?"
    r"(\d+(?:\.\d+)?)\s*(?:deg(?:ree)?s?|°)",
    re.I,
)

# SNR extraction
_SNR_PAT = re.compile(
    r"(?:S/?N|SNR|signal[- ]to[- ]noise)"
    r"[\s:=~]*"
    r"(\d+(?:\.\d+)?)",
    re.I,
)

# FAR extraction (false alarm rate, often in Hz or yr^-1)
_FAR_PAT = re.compile(
    r"(?:FAR|false\s+alarm\s+rate)"
    r"[\s:=~]*"
    r"([0-9]+(?:\.\d+)?(?:[eE][+-]?\d+)?)",
    re.I,
)

# DM extraction for FRBs (dispersion measure in pc/cm^3)
_DM_PAT = re.compile(
    r"(?:DM|dispersion\s+measure)"
    r"[\s:=~]*"
    r"(\d+(?:\.\d+)?)\s*(?:pc)",
    re.I,
)

# Fluence extraction
_FLUENCE_PAT = re.compile(
    r"(?:fluence)"
    r"[\s:=~]*"
    r"([0-9]+(?:\.\d+)?(?:[eE][+-]?\d+)?)",
    re.I,
)


def _hms_to_deg(h: float, m: float, s: float) -> float:
    """Convert hours, minutes, seconds to decimal degrees."""
    return (h + m / 60.0 + s / 3600.0) * 15.0


def _dms_to_deg(d: float, m: float, s: float) -> float:
    """Convert degrees, arcminutes, arcseconds to decimal degrees."""
    sign = -1.0 if d < 0 else 1.0
    return sign * (abs(d) + m / 60.0 + s / 3600.0)


def _extract_ra(body: str) -> float | None:
    """Try to extract RA in decimal degrees from a circular body."""
    m = _RA_HMS.search(body)
    if m:
        return round(_hms_to_deg(float(m.group(1)), float(m.group(2)), float(m.group(3))), 4)
    m = _RA_DEG.search(body)
    if m:
        return round(float(m.group(1)), 4)
    return None


def _extract_dec(body: str) -> float | None:
    """Try to extract Dec in decimal degrees from a circular body."""
    m = _DEC_DMS.search(body)
    if m:
        return round(_dms_to_deg(float(m.group(1)), float(m.group(2)), float(m.group(3))), 4)
    m = _DEC_DEG.search(body)
    if m:
        return round(float(m.group(1)), 4)
    return None


def _extract_error_radius(body: str) -> float:
    """Extract error radius in arcminutes.  Returns 0.0 on failure."""
    m = _ERR_ARCMIN.search(body)
    if m:
        return round(float(m.group(1)), 2)
    m = _ERR_ARCSEC.search(body)
    if m:
        return round(float(m.group(1)) / 60.0, 4)   # arcsec → arcmin
    m = _ERR_DEG.search(body)
    if m:
        return round(float(m.group(1)) * 60.0, 2)    # deg → arcmin
    return 0.0


def _extract_float(pattern: re.Pattern, body: str) -> float | None:
    """Generic single-float extractor."""
    m = pattern.search(body)
    if m:
        try:
            return float(m.group(1))
        except (ValueError, TypeError):
            pass
    return None


# ---------------------------------------------------------------------------
# Galactic coordinate helpers  (mirrors normalizer.py)
# ---------------------------------------------------------------------------

def _ra_dec_to_gal(ra: float, dec: float) -> tuple[float, float]:
    """Approximate equatorial → Galactic (IAU 1958 pole)."""
    ra_rad  = math.radians(ra)
    dec_rad = math.radians(dec)
    ra_gp   = math.radians(192.8595)
    dec_gp  = math.radians(27.1284)
    l_ncp   = math.radians(122.932)

    sin_b = (
        math.sin(dec_rad) * math.sin(dec_gp)
        + math.cos(dec_rad) * math.cos(dec_gp) * math.cos(ra_rad - ra_gp)
    )
    b = math.degrees(math.asin(max(-1.0, min(1.0, sin_b))))

    cos_b = math.cos(math.radians(b))
    if abs(cos_b) < 1e-10:
        return 0.0, round(b, 4)

    cos_l = math.cos(dec_rad) * math.sin(ra_rad - ra_gp) / cos_b
    sin_l = (
        (math.sin(dec_rad) - math.sin(math.radians(b)) * math.sin(dec_gp))
        / (cos_b * math.cos(dec_gp))
    )
    l = math.degrees(l_ncp - math.atan2(sin_l, cos_l)) % 360

    return round(l, 4), round(b, 4)


# ---------------------------------------------------------------------------
# Timeline & AstroEvent builder
# ---------------------------------------------------------------------------

def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds") + "Z"


def _unix_ms_to_iso(ts_ms: int | float) -> str:
    """Convert UNIX-millisecond timestamp to ISO-8601 UTC string."""
    dt = datetime.fromtimestamp(ts_ms / 1000.0, tz=timezone.utc)
    return dt.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _unix_ms_to_dt(ts_ms: int | float) -> datetime:
    return datetime.fromtimestamp(ts_ms / 1000.0, tz=timezone.utc)


def _build_event_from_group(
    canonical_name: str,
    event_type: str,
    circulars: list[dict],
) -> dict[str, Any]:
    """
    Build a single AstroEvent dict from a group of circulars that all
    refer to the same astrophysical event.

    Strategy
    --------
    * **detectionTime**: use the ``createdOn`` of the *earliest* circular.
    * **RA / Dec / errorRadius**: scan every circular body (earliest first)
      and take the first successful coordinate extraction.
    * **snr / far / dm / fluence**: same scan strategy.
    * **observatory**: inferred from the subject of the earliest circular
      that mentions a known instrument.
    """
    # Sort circulars chronologically (earliest first)
    sorted_circs = sorted(circulars, key=lambda c: c.get("createdOn", 0))

    earliest = sorted_circs[0]
    latest   = sorted_circs[-1]

    det_time = _unix_ms_to_iso(earliest["createdOn"])

    # Determine observatory from the first circular that names one
    observatory = "Unknown"
    for circ in sorted_circs:
        obs = _observatory_for(event_type, circ.get("subject", ""))
        if obs != "Multi-Mission":
            observatory = obs
            break
    if observatory == "Unknown":
        observatory = _observatory_for(event_type, "")

    # Scan bodies for coordinates and metadata
    ra: float | None  = None
    dec: float | None = None
    err: float        = 0.0
    snr: float | None = None
    far: float | None = None
    dm: float | None  = None
    fluence: float | None = None

    for circ in sorted_circs:
        body = circ.get("body", "")
        if ra is None:
            ra = _extract_ra(body)
        if dec is None:
            dec = _extract_dec(body)
        if err == 0.0:
            err = _extract_error_radius(body)
        if snr is None:
            snr = _extract_float(_SNR_PAT, body)
        if far is None:
            far = _extract_float(_FAR_PAT, body)
        if dm is None:
            dm = _extract_float(_DM_PAT, body)
        if fluence is None:
            fluence = _extract_float(_FLUENCE_PAT, body)
        # Stop early once we have both coordinates
        if ra is not None and dec is not None and err > 0.0:
            break

    ra_val  = ra  if ra  is not None else 0.0
    dec_val = dec if dec is not None else 0.0
    gal_lon, gal_lat = _ra_dec_to_gal(ra_val, dec_val) if (ra is not None or dec is not None) else (0.0, 0.0)

    # Build the circular-subjects timeline
    timeline = [
        {
            "circularId": c.get("circularId"),
            "subject":    c.get("subject", ""),
            "submitter":  c.get("submitter", ""),
            "timestamp":  _unix_ms_to_iso(c["createdOn"]),
        }
        for c in sorted_circs
    ]

    return {
        "id":             str(uuid.uuid4()),
        "eventId":        canonical_name,
        "eventType":      event_type,
        "observatory":    observatory,
        "topic":          "gcn.circulars",
        "detectionTime":  det_time,
        "ra":             ra_val,
        "dec":            dec_val,
        "errorRadius":    err,
        "snr":            snr if snr is not None else 0.0,
        "far":            far  if far  is not None else 0.0,
        "latencyUs":      0,
        "galLon":         gal_lon,
        "galLat":         gal_lat,
        "sunDistance":    90.0,
        "moonDistance":   90.0,
        "fluence":        fluence,
        "dm":             dm,
        "raw": {
            "source":          "gcn_circulars",
            "circular_count":  len(circulars),
            "first_circular":  earliest.get("circularId"),
            "last_circular":   latest.get("circularId"),
            "timeline":        timeline,
        },
        "createdAt":      _now_iso(),
    }


# ---------------------------------------------------------------------------
# Archive download & parsing
# ---------------------------------------------------------------------------

def _download_archive() -> list[dict]:
    """
    Download ``archive.json.tar.gz`` from GCN and return the parsed
    list of circular dicts.

    The archive is a gzip'd tar containing a *directory* of individual
    ``.json`` files — one per circular.  Each file holds a single JSON
    object (dict) with keys like ``circularId``, ``subject``, ``body``,
    ``createdOn``, ``eventId``, etc.

    We also handle the (less common) layout where the archive contains a
    single large JSON array, for forward-compatibility.
    """
    print(f"Downloading GCN Circulars archive from {ARCHIVE_URL} ...")

    req = urllib.request.Request(
        ARCHIVE_URL,
        headers={
            "Accept":     "application/gzip",
            "User-Agent": "TransientEventDetection/1.0",
        },
    )

    with urllib.request.urlopen(req, timeout=DOWNLOAD_TIMEOUT_S) as resp:
        raw_bytes = resp.read()

    print(f"  Downloaded {len(raw_bytes) / (1024 * 1024):.1f} MB")

    # Parsing lives in _parse_archive_bytes so the DB backfill reads the
    # archive through exactly the same code path as this pipeline.
    return _parse_archive_bytes(raw_bytes)


def load_archive(path: Path | None = None) -> list[dict]:
    """
    Return every circular in the GCN archive, from a local file or the network.

    Split out so the historical database backfill
    (backend/scripts/backfill_gcn_circulars.py) reuses this parser instead of
    carrying a second one. A repository with two archive readers is a
    repository where they disagree.

    Parameters
    ----------
    path : Path | None
        A local ``archive.json.tar.gz``. When None the archive is downloaded.
        The repository already ships ``gcn_archive.json.tar.gz`` at the project
        root, so a backfill normally needs no network at all.
    """
    if path is None:
        return _download_archive()

    if not path.exists():
        raise FileNotFoundError(f"GCN archive not found: {path}")

    print(f"Reading GCN Circulars archive from {path} ...")
    with open(path, "rb") as fh:
        return _parse_archive_bytes(fh.read())


def _parse_archive_bytes(raw_bytes: bytes) -> list[dict]:
    """
    Parse the bytes of ``archive.json.tar.gz`` into a list of circular dicts.

    The archive is a gzipped tar holding one JSON file per circular. The
    single-large-array layout is also handled, for forward-compatibility.
    """
    circulars: list[dict] = []
    buf = io.BytesIO(raw_bytes)

    with tarfile.open(fileobj=buf, mode="r:gz") as tar:
        json_members = [
            m for m in tar.getmembers()
            if m.isfile() and m.name.endswith(".json")
        ]

        if not json_members:
            raise RuntimeError("No .json files found inside the tar archive")

        print(f"  Found {len(json_members):,} JSON files in archive")

        if len(json_members) == 1 and json_members[0].size > 1_000_000:
            member = json_members[0]
            f = tar.extractfile(member)
            if f is None:
                raise RuntimeError(f"Cannot extract {member.name}")
            data = json.loads(f.read())
            if isinstance(data, list):
                circulars = [c for c in data if isinstance(c, dict)]
            elif isinstance(data, dict):
                circulars = [data]
        else:
            parsed = 0
            errors = 0
            for member in json_members:
                try:
                    f = tar.extractfile(member)
                    if f is None:
                        continue
                    data = json.loads(f.read())
                    if isinstance(data, dict):
                        circulars.append(data)
                    elif isinstance(data, list):
                        circulars.extend(c for c in data if isinstance(c, dict))
                    parsed += 1
                except Exception as exc:
                    errors += 1
                    if errors <= 3:
                        print(f"  [warn] Failed to parse {member.name}: {exc}")
            if errors > 3:
                print(f"  [warn] ... and {errors - 3} more parse errors")
            print(f"  Parsed {parsed:,} files ({errors} errors)")

    print(f"  Total circulars: {len(circulars):,}")
    return circulars


def _filter_by_date(circulars: list[dict], cutoff: datetime) -> list[dict]:
    """Keep only circulars whose ``createdOn`` is ≥ cutoff."""
    cutoff_ms = cutoff.timestamp() * 1000
    recent = [c for c in circulars if c.get("createdOn", 0) >= cutoff_ms]
    print(f"  {len(recent):,} circulars in the last {(datetime.now(timezone.utc) - cutoff).days} days")
    return recent


def _group_by_event(circulars: list[dict]) -> dict[str, dict]:
    """
    Group circulars by canonical event name.

    Returns ``{ canonical_name: { "event_type": str, "circulars": list } }``.
    """
    groups: dict[str, dict] = {}

    for circ in circulars:
        # Prefer the pre-extracted eventId from GCN, fall back to subject
        raw_event_id = circ.get("eventId") or ""
        subject      = circ.get("subject", "")

        # Try eventId first, then subject
        if raw_event_id:
            canonical, etype = _classify_event_name(raw_event_id)
        else:
            canonical, etype = _classify_event_name(subject)

        # Skip circulars we can't map to a known event
        if not canonical or canonical == subject.strip():
            continue

        if canonical not in groups:
            groups[canonical] = {"event_type": etype, "circulars": []}
        groups[canonical]["circulars"].append(circ)

    print(f"  Grouped into {len(groups):,} distinct events")
    return groups


# ---------------------------------------------------------------------------
# Deduplication & output
# ---------------------------------------------------------------------------

def _load_existing_events() -> dict[str, dict]:
    """Load existing ``historical_events.json`` into a dict keyed by eventId."""
    events_by_id: dict[str, dict] = {}
    if HISTORY_JSON.exists():
        try:
            with open(HISTORY_JSON, "r", encoding="utf-8") as f:
                for ev in json.load(f):
                    eid = ev.get("eventId")
                    if eid:
                        events_by_id[eid] = ev
            print(f"  Loaded {len(events_by_id):,} existing events from {HISTORY_JSON.name}")
        except Exception as exc:
            print(f"  [warn] Failed to load {HISTORY_JSON.name}: {exc}")
    return events_by_id


def _write_merged(events_by_id: dict[str, dict]) -> None:
    """Sort by detectionTime descending and write JSON."""
    def _key(e: dict) -> str:
        return e.get("detectionTime") or e.get("createdAt") or ""

    all_events = sorted(events_by_id.values(), key=_key, reverse=True)

    HISTORY_JSON.parent.mkdir(parents=True, exist_ok=True)
    with open(HISTORY_JSON, "w", encoding="utf-8") as fh:
        json.dump(all_events, fh, indent=2, ensure_ascii=False, default=str)

    print(f"  Written {len(all_events):,} total events → {HISTORY_JSON}")


# ---------------------------------------------------------------------------
# Main pipeline
# ---------------------------------------------------------------------------

def ingest_circulars(
    *,
    days: int = 120,
    dry_run: bool = False,
) -> list[dict]:
    """
    Full pipeline: download → filter → group → build → deduplicate → write.

    Parameters
    ----------
    days : int
        How many days of history to consider.
    dry_run : bool
        If True, print a summary but do not write the output file.

    Returns
    -------
    list[dict]
        The newly produced AstroEvent dicts (before merging).
    """
    print(f"\n{'='*60}")
    print("GCN Circulars Ingest Pipeline")
    print(f"{'='*60}")

    cutoff = datetime.now(timezone.utc) - timedelta(days=days)
    print(f"  Window     : last {days} days  (since {cutoff.date().isoformat()})")
    print(f"  Output     : {HISTORY_JSON}")
    print(f"  Dry run    : {dry_run}")
    print()

    # ── 1. Download ──────────────────────────────────────────────────────────
    circulars = _download_archive()

    # ── 2. Filter by date ────────────────────────────────────────────────────
    recent = _filter_by_date(circulars, cutoff)
    if not recent:
        print("  No circulars found in the specified window.")
        return []

    # ── 3. Group by event name ───────────────────────────────────────────────
    groups = _group_by_event(recent)
    if not groups:
        print("  No events could be extracted from circulars.")
        return []

    # ── 4. Build AstroEvent per event ────────────────────────────────────────
    new_events: list[dict] = []
    for canonical_name, info in groups.items():
        ev = _build_event_from_group(
            canonical_name,
            info["event_type"],
            info["circulars"],
        )
        new_events.append(ev)

    print(f"\n  Built {len(new_events):,} AstroEvent dicts from circulars")

    # Print a breakdown by type
    type_counts: dict[str, int] = {}
    for ev in new_events:
        t = ev["eventType"]
        type_counts[t] = type_counts.get(t, 0) + 1
    for t, c in sorted(type_counts.items()):
        print(f"    {t}: {c}")

    if dry_run:
        print(f"\n  [dry-run] Would merge {len(new_events)} events.  Sample:")
        sample = new_events[0]
        print(json.dumps(sample, indent=2, default=str)[:2000])
        return new_events

    # ── 5. Deduplicate & merge ───────────────────────────────────────────────
    print()
    existing = _load_existing_events()
    merged_count = 0
    new_count    = 0

    for ev in new_events:
        eid = ev["eventId"]
        if eid in existing:
            # Keep the existing event but enrich with circular timeline
            # if the existing event doesn't already have one.
            existing_raw = existing[eid].get("raw", {})
            if isinstance(existing_raw, dict) and existing_raw.get("source") != "gcn_circulars":
                # Attach timeline as supplementary data
                if "circulars_timeline" not in existing_raw:
                    existing_raw["circulars_timeline"] = ev["raw"].get("timeline", [])
                    existing[eid]["raw"] = existing_raw
                    merged_count += 1
        else:
            existing[eid] = ev
            new_count += 1

    print(f"  New events added  : {new_count}")
    print(f"  Existing enriched : {merged_count}")
    print(f"  Already present   : {len(new_events) - new_count - merged_count}")

    # ── 6. Write ─────────────────────────────────────────────────────────────
    _write_merged(existing)

    print(f"\n{'='*60}")
    print("Circulars ingest complete.")
    print(f"{'='*60}\n")

    return new_events


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="Ingest GCN Circulars into historical_events.json",
    )
    p.add_argument(
        "--days", type=int, default=120,
        help="Number of days of history to ingest (default: 120)",
    )
    p.add_argument(
        "--dry-run", action="store_true",
        help="Download and process but do NOT write the output file",
    )
    p.add_argument(
        "--out", type=Path, default=None,
        help=f"Override output path (default: {HISTORY_JSON})",
    )
    return p.parse_args()


def main() -> None:
    args = parse_args()

    if args.out:
        global HISTORY_JSON          # noqa: PLW0603
        HISTORY_JSON = args.out

    events = ingest_circulars(days=args.days, dry_run=args.dry_run)

    if not events:
        print("No events produced.")
        sys.exit(0)


if __name__ == "__main__":
    main()

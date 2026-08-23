"""
ingest_gcn_archive.py
â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
Historical GCN Archive Ingestion Pipeline for Transient Event Detection.

Source  : https://gcn.nasa.gov/circulars/archive.json.tar.gz
Filters : createdOn >= 2026-01-01
Output  : historical_events_2026.json  (AstroEvent-compatible records)

Usage:
    python ingest_gcn_archive.py
    python ingest_gcn_archive.py --out custom_output.json
    python ingest_gcn_archive.py --no-download  (reuse existing .tar.gz)
    python ingest_gcn_archive.py --dry-run

Requires:
    pip install requests  (already in project)
â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
"""

from __future__ import annotations

import argparse
import io
import json
import math
import os
import re
import sys
import tarfile
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

try:
    import requests
except ImportError:
    print("ERROR: 'requests' is required.  pip install requests")
    sys.exit(1)

# â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
# Constants
# â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

ARCHIVE_URL   = "https://gcn.nasa.gov/circulars/archive.json.tar.gz"
ARCHIVE_LOCAL = Path("gcn_archive.json.tar.gz")
CUTOFF_DATE   = datetime(2026, 1, 1, tzinfo=timezone.utc)
DEFAULT_OUT   = Path("historical_events_2026.json")

# â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
# Observatory / subject-line patterns
# â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

# Master regex that covers GRB, GW (S/MS superevents), FRB, EP (Einstein Probe),
# IceCube (IC), neutrino (NU), AT (ATel-style), Swift/Fermi triggers.
# The named group <name> captures the canonical event ID.
EVENT_ID_PATTERNS: list[re.Pattern] = [
    # GRB  e.g. GRB 260609A  /  GRB260609A  /  GRB260609AB
    re.compile(
        r'\bGRB\s?(\d{6}[A-Z]{1,3})\b',
        re.IGNORECASE,
    ),
    # Einstein Probe  e.g. EP250101A
    re.compile(
        r'\bEP\s?(\d{6}[A-Z]{1,3})\b',
        re.IGNORECASE,
    ),
    # IceCube  e.g. IC260512A  /  IceCube-260512A
    re.compile(
        r'\bIC(?:eCube)?[-\s]?(\d{6}[A-Z]{1,3})\b',
        re.IGNORECASE,
    ),
    # FRB  e.g. FRB 20260528A  /  FRB260528A
    re.compile(
        r'\bFRB\s?2?0?(\d{6}[A-Z]{1,3})\b',
        re.IGNORECASE,
    ),
    # LIGO/Virgo GW superevent  e.g. S260605a  /  MS260605a
    re.compile(
        r'\b([MS]\d{6}[a-z]{1,3})\b',
    ),
    # AT (Astronomer's Telegram / ZTF style)  e.g. AT2026abc
    re.compile(
        r'\bAT\s?(2026\w{2,6})\b',
        re.IGNORECASE,
    ),
]

# Maps keyword tokens found in subject â†’ (event_type, observatory)
SUBJECT_TYPE_HINTS: list[tuple[re.Pattern, str, str]] = [
    (re.compile(r'\bGRB\b',                        re.IGNORECASE), "GRB", ""),
    (re.compile(r'\beinstein\s*probe\b|EP\d{6}',   re.IGNORECASE), "GRB", "Einstein Probe (WXT)"),
    (re.compile(r'\bIceCube\b|\bIC\d{6}\b',        re.IGNORECASE), "NU",  "IceCube"),
    (re.compile(r'\bFRB\b',                         re.IGNORECASE), "FRB", "CHIME"),
    (re.compile(r'\bLIGO\b|\bVirgo\b|\bKAGRA\b|\bGW\b|\b[MS]\d{6}[a-z]', re.IGNORECASE), "GW", "LIGO/Virgo/KAGRA"),
    (re.compile(r'\bSwift\b|\bBAT\b|\bXRT\b|\bUVOT\b',re.IGNORECASE), "GRB", "Swift (BAT)"),
    (re.compile(r'\bFermi\b|\bGBM\b|\bLAT\b',      re.IGNORECASE), "GRB", "Fermi (GBM)"),
    (re.compile(r'\bINTEGRAL\b',                    re.IGNORECASE), "GRB", "INTEGRAL"),
    (re.compile(r'\bMAXI\b',                        re.IGNORECASE), "GRB", "MAXI/GSC"),
    (re.compile(r'\bCHIME\b',                       re.IGNORECASE), "FRB", "CHIME"),
    (re.compile(r'\bALERT.*neutrino\b|\bneutrino\s*alert\b', re.IGNORECASE), "NU", "IceCube"),
]

# Observatory name normalisation from submitter / keyword tokens
OBSERVATORY_ALIASES: dict[str, str] = {
    "swift":    "Swift (BAT)",
    "bat":      "Swift (BAT)",
    "xrt":      "Swift (XRT)",
    "uvot":     "Swift (UVOT)",
    "fermi":    "Fermi (GBM)",
    "gbm":      "Fermi (GBM)",
    "lat":      "Fermi (LAT)",
    "integral": "INTEGRAL",
    "maxi":     "MAXI/GSC",
    "chime":    "CHIME",
    "icecube":  "IceCube",
    "ligo":     "LIGO/Virgo/KAGRA",
    "virgo":    "LIGO/Virgo/KAGRA",
    "kagra":    "LIGO/Virgo/KAGRA",
    "ep":       "Einstein Probe (WXT)",
    "einstein probe": "Einstein Probe (WXT)",
}

# â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
# Step 1 â€” Download
# â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

def download_archive(url: str, dest: Path, force: bool = False) -> None:
    if dest.exists() and not force:
        size_mb = dest.stat().st_size / 1_048_576
        print(f"  [skip] Archive already present: {dest}  ({size_mb:.1f} MB)")
        return

    print(f"  Downloading {url} â€¦")
    t0 = time.perf_counter()
    resp = requests.get(url, stream=True, timeout=120)
    resp.raise_for_status()

    total = int(resp.headers.get("content-length", 0))
    downloaded = 0
    with open(dest, "wb") as fh:
        for chunk in resp.iter_content(chunk_size=65_536):
            fh.write(chunk)
            downloaded += len(chunk)
            if total:
                pct = downloaded / total * 100
                print(f"\r  {pct:5.1f}%  {downloaded/1_048_576:.1f}/{total/1_048_576:.1f} MB", end="", flush=True)
    elapsed = time.perf_counter() - t0
    print(f"\n  Downloaded {downloaded/1_048_576:.1f} MB in {elapsed:.1f}s -> {dest}")

# â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
# Step 2 â€” Extract & parse all JSON records
# â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

def extract_circulars(archive_path: Path) -> list[dict]:
    """
    Open the .tar.gz and read every .json member.
    Each member may be a single circular object OR a JSON array.
    Returns a flat list of circular dicts.
    """
    circulars: list[dict] = []

    with tarfile.open(archive_path, "r:gz") as tf:
        members = tf.getmembers()
        print(f"  Tar members: {len(members):,}")

        for member in members:
            if not member.name.endswith(".json"):
                continue
            fobj = tf.extractfile(member)
            if fobj is None:
                continue
            try:
                raw = json.load(fobj)
            except json.JSONDecodeError:
                continue

            if isinstance(raw, list):
                circulars.extend(raw)
            elif isinstance(raw, dict):
                circulars.append(raw)

    return circulars

# â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
# Step 3 â€” Filter by date
# â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

def parse_created_on(value) -> Optional[datetime]:
    """
    GCN stores createdOn as a UNIX timestamp in *milliseconds* (integer).
    Some older exports may use ISO strings â€” handle both.
    """
    if value is None:
        return None
    try:
        if isinstance(value, (int, float)):
            # milliseconds since epoch
            return datetime.fromtimestamp(value / 1000.0, tz=timezone.utc)
        if isinstance(value, str):
            # ISO 8601 string
            return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except (ValueError, OSError, OverflowError):
        return None
    return None


def filter_by_date(circulars: list[dict], cutoff: datetime) -> list[dict]:
    accepted, skipped_no_date, skipped_before = [], 0, 0
    for c in circulars:
        dt = parse_created_on(c.get("createdOn"))
        if dt is None:
            skipped_no_date += 1
            continue
        if dt < cutoff:
            skipped_before += 1
            continue
        c["_parsedDate"] = dt      # stash for later use
        accepted.append(c)

    print(f"  After date filter  (>= {cutoff.date()}): {len(accepted):,} kept")
    print(f"  Skipped (no date) : {skipped_no_date:,}")
    print(f"  Skipped (pre-2026): {skipped_before:,}")
    return accepted

# â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
# Step 4 â€” Extract canonical event ID from subject line
# â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

def extract_event_id(subject: str) -> Optional[str]:
    """
    Try each pattern in order; return the first canonical name found.
    Normalises the ID to upper-case for the prefix and preserves suffix case.
    """
    if not subject:
        return None

    for pattern in EVENT_ID_PATTERNS:
        m = pattern.search(subject)
        if m:
            matched = m.group(0).replace(" ", "")   # collapse any spaces
            # For GW superevents keep lowercase suffix; everything else uppercase
            if re.match(r'^[MS]\d{6}[a-z]{1,3}$', matched):
                return matched
            # Normalise: prefix upper, numeric middle, letter suffix upper
            return matched.upper()

    return None


def normalise_event_id(raw: str) -> str:
    """
    Ensure canonical prefixes are attached correctly.
    e.g. "GRB260609A" stays as-is; "IC260512A" â†’ "IC260512A".
    """
    raw = raw.strip()
    # Already has a known prefix?  Trust it.
    for pfx in ("GRB", "EP", "IC", "FRB", "AT"):
        if raw.upper().startswith(pfx):
            return raw.upper()
    # GW superevent (starts S or M followed by 6 digits + lowercase)
    if re.match(r'^[SM]\d{6}[a-z]+$', raw):
        return raw
    return raw.upper()

# â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
# Step 5 â€” Infer event_type and observatory
# â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

def infer_type_observatory(subject, event_id, submitter=""):
    import re as _re
    eid_upper = event_id.upper()
    observatory = ""
    # eventType from eventId prefix
    if eid_upper.startswith("GRB"):
        event_type = "GRB"
    elif eid_upper.startswith("EP"):
        event_type  = "EP"
        observatory = "Einstein Probe (WXT)"
    elif eid_upper.startswith("IC") or "ICECUBE" in eid_upper:
        event_type  = "NU"
        observatory = "IceCube"
    elif eid_upper.startswith("FRB"):
        event_type  = "FRB"
        observatory = "CHIME"
    elif _re.match(r"^(MS|S)\d{6}[a-z]+", event_id, _re.IGNORECASE):
        event_type  = "GW"
        observatory = "LIGO/Virgo/KAGRA"
    else:
        event_type  = "OTHER"
    # resolve observatory from subject / submitter hints
    combined = f"{subject} {submitter}"
    if not observatory:
        for pattern, etype, obs in SUBJECT_TYPE_HINTS:
            if pattern.search(combined):
                if obs:
                    observatory = obs
                    break
    # alias fallback
    if not observatory:
        cl = combined.lower()
        for alias, obs_name in OBSERVATORY_ALIASES.items():
            if alias in cl:
                observatory = obs_name
                break
    if not observatory:
        observatory = "Unknown"
    return event_type, observatory

def group_by_event(circulars: list[dict]) -> dict[str, list[dict]]:
    groups: dict[str, list[dict]] = {}
    skipped_no_id = 0

    for c in circulars:
        subject  = c.get("subject", "") or ""
        event_id = extract_event_id(subject)
        if not event_id:
            skipped_no_id += 1
            continue
        event_id = normalise_event_id(event_id)
        groups.setdefault(event_id, []).append(c)

    print(f"  Events identified  : {len(groups):,}")
    print(f"  Circulars with no event ID: {skipped_no_id:,}")
    return groups


def pick_best_circular(circulars: list[dict]) -> dict:
    """
    From multiple circulars for the same event, pick the most informative one.
    Preference: earliest detection notice > follow-up > not a correction.
    We sort by createdOn ascending and return the first (= earliest) record.
    """
    def sort_key(c):
        dt = c.get("_parsedDate")
        return dt if dt else datetime.max.replace(tzinfo=timezone.utc)

    return sorted(circulars, key=sort_key)[0]

# â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
# Step 7 â€” Convert one circular â†’ AstroEvent dict
# â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

def circular_to_astro_event(event_id: str, circular: dict) -> dict:
    subject   = circular.get("subject", "") or ""
    submitter = circular.get("submitter", "") or ""
    dt        = circular.get("_parsedDate")   # already a datetime

    event_type, observatory = infer_type_observatory(subject, event_id, submitter)

    # detection_time is the circular publication time (best proxy we have
    # from text-based circulars; actual trigger time is buried in the body)
    detection_time = dt.isoformat() if dt else None

    return {
        "eventId":          event_id,
        "eventType":        event_type,
        "observatory":      observatory,
        "detectionTime":    detection_time,
        "lifecycle":        "confirmed",
        "source":           "gcn_archive",
        "isHistorical":     True,
        # Reference fields for traceability
        "circularId":       circular.get("circularId"),
        "subject":          subject,
        "circularCount":    None,   # filled in after grouping
    }

# â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
# Step 8 â€” Build final event list
# â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

def build_events(groups: dict[str, list[dict]]) -> list[dict]:
    events: list[dict] = []

    for event_id, circulars in groups.items():
        best      = pick_best_circular(circulars)
        event     = circular_to_astro_event(event_id, best)
        event["circularCount"] = len(circulars)
        events.append(event)

    # Sort newest-first (mirrors dashboard default ordering)
    events.sort(
        key=lambda e: e.get("detectionTime") or "",
        reverse=True,
    )
    return events

# â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
# Statistics
# â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

def print_stats(total_circulars: int, events: list[dict], cutoff: datetime) -> None:
    if not events:
        print("  No events generated.")
        return

    dates = [e["detectionTime"] for e in events if e.get("detectionTime")]
    date_min = min(dates) if dates else "?"
    date_max = max(dates) if dates else "?"

    type_dist: dict[str, int] = {}
    obs_dist:  dict[str, int] = {}
    multi_circular = 0

    for e in events:
        t = e.get("eventType", "OTHER")
        o = e.get("observatory", "Unknown")
        type_dist[t] = type_dist.get(t, 0) + 1
        obs_dist[o]  = obs_dist.get(o, 0)  + 1
        if (e.get("circularCount") or 1) > 1:
            multi_circular += 1

    bar = "=" * 60
    print(f"\n{bar}")
    print("  GCN ARCHIVE INGESTION â€” SUMMARY")
    print(bar)
    print(f"  Total circulars parsed   : {total_circulars:>7,}")
    print(f"  Date filter cutoff       : {cutoff.date()}")
    print(f"  Unique events created    : {len(events):>7,}")
    print(f"  Events with >1 circular  : {multi_circular:>7,}")
    print(f"  Date range               : {date_min[:10]}  â†’  {date_max[:10]}")
    print()
    print("  Event type breakdown:")
    for etype, cnt in sorted(type_dist.items(), key=lambda x: -x[1]):
        print(f"    {cnt:>5,}  {etype}")
    print()
    print("  Observatory breakdown (top 10):")
    for obs, cnt in sorted(obs_dist.items(), key=lambda x: -x[1])[:10]:
        print(f"    {cnt:>5,}  {obs}")
    print(bar)

# â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
# CLI
# â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="Ingest GCN Circulars archive and produce Transient Event Detection historical events JSON"
    )
    p.add_argument("--out",         type=Path,  default=DEFAULT_OUT,
                   help=f"Output file path (default: {DEFAULT_OUT})")
    p.add_argument("--archive",     type=Path,  default=ARCHIVE_LOCAL,
                   help=f"Local archive path (default: {ARCHIVE_LOCAL})")
    p.add_argument("--no-download", action="store_true",
                   help="Skip download â€” reuse existing archive file")
    p.add_argument("--force-download", action="store_true",
                   help="Force re-download even if archive already exists")
    p.add_argument("--dry-run",     action="store_true",
                   help="Parse and report but do not write output file")
    p.add_argument("--cutoff",      type=str,   default="2026-01-01",
                   help="ISO date cutoff, keep >= this date (default: 2026-01-01)")
    return p.parse_args()

# â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
# Main
# â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

def main() -> None:
    args   = parse_args()
    cutoff = datetime.fromisoformat(args.cutoff).replace(tzinfo=timezone.utc)
    bar    = "=" * 60

    print(f"\n{bar}")
    print("  Transient Event Detection â€” GCN Archive Ingestion Pipeline")
    print(bar)
    print(f"  Archive URL  : {ARCHIVE_URL}")
    print(f"  Local cache  : {args.archive}")
    print(f"  Output       : {args.out}")
    print(f"  Cutoff date  : {cutoff.date()}")
    print(f"  Dry run      : {args.dry_run}")
    print(f"{bar}\n")

    # â”€â”€ 1. Download â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    if args.no_download:
        if not args.archive.exists():
            print(f"ERROR: --no-download set but {args.archive} does not exist.")
            sys.exit(1)
        print(f"[1/5] Using existing archive: {args.archive}")
    else:
        print("[1/5] Downloading archive â€¦")
        download_archive(ARCHIVE_URL, args.archive, force=args.force_download)

    # â”€â”€ 2. Extract â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    print(f"\n[2/5] Extracting circulars from {args.archive} â€¦")
    all_circulars = extract_circulars(args.archive)
    print(f"  Total circulars in archive: {len(all_circulars):,}")

    # â”€â”€ 3. Date filter â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    print(f"\n[3/5] Filtering by date (>= {cutoff.date()}) â€¦")
    recent = filter_by_date(all_circulars, cutoff)

    if not recent:
        print("  No circulars found after cutoff date. Exiting.")
        sys.exit(0)

    # â”€â”€ 4. Group by event â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    print(f"\n[4/5] Grouping {len(recent):,} circulars by canonical event ID â€¦")
    groups = group_by_event(recent)

    # â”€â”€ 5. Build & save events â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    print(f"\n[5/5] Building AstroEvent records â€¦")
    events = build_events(groups)

    # Stats
    print_stats(len(all_circulars), events, cutoff)

    if args.dry_run:
        print("\n[dry-run] Output file NOT written.")
        return

    args.out.parent.mkdir(parents=True, exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(events, fh, indent=2, ensure_ascii=False, default=str)

    print(f"\n[OK] Written {len(events):,} events -> {args.out}")
    print("  To ingest into Transient Event Detection:")
    print("    Copy the file to artifacts/api-server/recent_events.json")
    print("    (or load it via the bootstrap mechanism / a custom loader)")
    print()


if __name__ == "__main__":
    main()


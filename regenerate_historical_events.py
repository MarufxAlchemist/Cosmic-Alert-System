"""
regenerate_historical_events.py
---------------------------------
Regenerates historical_events.json from the live core.events database table.

Applies the same production filtering rules as alertFilter.ts:

  1.  is_retraction = true              → rejected (retractions)
  2.  observatory = 'Unknown'           → rejected (pre-migration rows without real source info)
  3.  alert_type IN ('RETRACTION')      → rejected (belt-and-suspenders)
  4.  alert_type IN ('TEST')            → rejected (test triggers)
  5.  lifecycle = '' OR lifecycle NULL  → rejected (incomplete metadata)

All accepted events are exported with the full filtering metadata fields:
  lifecycle, alertType, classificationTier, observatory, isRetraction

Usage (from project root, with DATABASE_URL set):
    python regenerate_historical_events.py
    python regenerate_historical_events.py --out historical_events.json
    python regenerate_historical_events.py --include-unknown --limit 500
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

try:
    import psycopg2
    import psycopg2.extras
except ImportError:
    print("ERROR: psycopg2 is required.  Install with:  pip install psycopg2-binary")
    sys.exit(1)

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

PROJECT_ROOT = Path(__file__).resolve().parent
DEFAULT_OUT   = PROJECT_ROOT / "historical_events.json"

# These alert_type values are always rejected regardless of other fields
REJECTED_ALERT_TYPES = {"RETRACTION", "TEST"}

# ---------------------------------------------------------------------------
# SQL query — pulls all columns needed for the AstroEvent schema
# ---------------------------------------------------------------------------

QUERY = """
SELECT
    id::text,
    event_id         AS "eventId",
    event_type       AS "eventType",
    observatory,
    detection_time   AS "detectionTime",
    ra,
    dec,
    error_radius     AS "errorRadius",
    snr,
    far,
    fluence,
    dm,
    t90,
    peak_flux        AS "peakFlux",
    chirp_mass       AS "chirpMass",
    luminosity_distance AS "luminosityDistance",
    gal_lat          AS "galLat",
    gal_lon          AS "galLon",
    sun_distance     AS "sunDistance",
    moon_distance    AS "moonDistance",
    latency_us::bigint AS "latencyUs",
    lifecycle,
    alert_type       AS "alertType",
    classification_tier AS "classificationTier",
    is_retraction    AS "isRetraction",
    created_at       AS "createdAt"
FROM core.events
ORDER BY detection_time DESC
LIMIT %(limit)s;
"""

# ---------------------------------------------------------------------------
# Filter predicate — mirrors alertFilter.ts rules exactly
# ---------------------------------------------------------------------------

def should_reject(row: dict, include_unknown: bool) -> tuple[bool, str]:
    """
    Returns (True, reason) if the row must be excluded from the dataset.
    Returns (False, "") if the row should be kept.
    """
    # Rule 1 — explicit retraction flag
    if row.get("isRetraction"):
        return True, "isRetraction=true"

    # Rule 2 — observatory unknown (pre-migration row)
    if not include_unknown and (not row.get("observatory") or row["observatory"] == "Unknown"):
        return True, f"observatory='{row.get('observatory')}' (pre-migration)"

    # Rule 3 — alert_type == RETRACTION
    alert_type = (row.get("alertType") or "").upper().strip()
    if alert_type in REJECTED_ALERT_TYPES:
        return True, f"alertType='{alert_type}'"

    # Rule 4 — mock/MDC GW superevents (superevent_id starts with "M")
    event_id = row.get("eventId", "")
    if row.get("eventType") == "GW" and event_id.startswith("M"):
        return True, f"GW mock event: eventId='{event_id}' starts with M"

    # Rule 5 — incomplete lifecycle (NULL or empty)
    lifecycle = (row.get("lifecycle") or "").strip()
    if not lifecycle:
        return True, "lifecycle is NULL or empty"

    return False, ""

# ---------------------------------------------------------------------------
# Serialisation helpers
# ---------------------------------------------------------------------------

def _serialise_value(v):
    """Make psycopg2 column values JSON-serialisable."""
    if isinstance(v, datetime):
        return v.isoformat()
    if hasattr(v, "__float__"):   # Decimal
        return float(v)
    return v

def serialise_row(row: dict) -> dict:
    return {k: _serialise_value(v) for k, v in row.items()}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="Regenerate historical_events.json from DB with production filtering rules"
    )
    p.add_argument(
        "--out", type=Path, default=DEFAULT_OUT,
        help=f"Output path (default: {DEFAULT_OUT})"
    )
    p.add_argument(
        "--limit", type=int, default=10_000,
        help="Maximum rows to pull from DB before filtering (default: 10000)"
    )
    p.add_argument(
        "--include-unknown", action="store_true",
        help="Include rows with observatory='Unknown' (pre-migration rows)"
    )
    p.add_argument(
        "--dry-run", action="store_true",
        help="Print stats without writing the file"
    )
    return p.parse_args()


def main() -> None:
    args = parse_args()

    db_url = os.environ.get("DATABASE_URL")
    if not db_url:
        # Try loading from .env at project root
        env_path = PROJECT_ROOT / ".env"
        if env_path.exists():
            for line in env_path.read_text().splitlines():
                line = line.strip()
                if line.startswith("DATABASE_URL="):
                    db_url = line.split("=", 1)[1].strip()
                    break

    if not db_url:
        print("ERROR: DATABASE_URL not set and .env not found.")
        sys.exit(1)

    print(f"\n{'='*60}")
    print("Transient Event Detection — Historical Events Regeneration")
    print(f"{'='*60}")
    print(f"Source  : PostgreSQL  core.events")
    print(f"Output  : {args.out}")
    print(f"Limit   : {args.limit:,} rows pre-filter")
    print(f"Unknown : {'include' if args.include_unknown else 'exclude'}")
    print(f"Dry run : {args.dry_run}")
    print(f"{'='*60}\n")

    # Connect
    try:
        conn = psycopg2.connect(db_url)
        cur  = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    except Exception as exc:
        print(f"ERROR: Cannot connect to database: {exc}")
        sys.exit(1)

    # Fetch
    print(f"Querying up to {args.limit:,} events ...")
    cur.execute(QUERY, {"limit": args.limit})
    raw_rows = cur.fetchall()
    cur.close()
    conn.close()

    print(f"  Fetched {len(raw_rows):,} rows from DB\n")

    # Apply filter
    accepted: list[dict] = []
    rejected_counts: dict[str, int] = {}
    total_rejected = 0

    for raw in raw_rows:
        row = dict(raw)
        rejected, reason = should_reject(row, args.include_unknown)
        if rejected:
            total_rejected += 1
            rejected_counts[reason] = rejected_counts.get(reason, 0) + 1
        else:
            accepted.append(serialise_row(row))

    # Print report
    print("Filter results")
    print("-" * 40)
    print(f"  Fetched   : {len(raw_rows):>6,}")
    print(f"  Accepted  : {len(accepted):>6,}")
    print(f"  Rejected  : {total_rejected:>6,}")
    print()

    if rejected_counts:
        print("  Rejection breakdown:")
        for reason, count in sorted(rejected_counts.items(), key=lambda x: -x[1]):
            print(f"    {count:>4}  {reason}")
    print()

    # Lifecycle distribution
    lc_dist: dict[str, int] = {}
    tier_dist: dict[str, int] = {}
    obs_dist: dict[str, int] = {}

    for e in accepted:
        lc   = e.get("lifecycle") or "unknown"
        tier = e.get("classificationTier") or ""
        obs  = e.get("observatory") or "Unknown"
        lc_dist[lc]   = lc_dist.get(lc, 0) + 1
        obs_dist[obs] = obs_dist.get(obs, 0) + 1
        if tier:
            tier_dist[tier] = tier_dist.get(tier, 0) + 1

    print("  Lifecycle distribution:")
    for lc, cnt in sorted(lc_dist.items(), key=lambda x: -x[1]):
        print(f"    {cnt:>5}  {lc}")
    print()

    if tier_dist:
        print("  IceCube tier distribution:")
        for tier, cnt in sorted(tier_dist.items(), key=lambda x: -x[1]):
            print(f"    {cnt:>5}  {tier}")
        print()

    print("  Observatory distribution:")
    for obs, cnt in sorted(obs_dist.items(), key=lambda x: -x[1]):
        print(f"    {cnt:>5}  {obs}")
    print()

    if args.dry_run:
        print("[dry-run] File NOT written.")
        return

    # Write output
    args.out.parent.mkdir(parents=True, exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(accepted, fh, indent=2, ensure_ascii=False, default=str)

    print(f"Written {len(accepted):,} clean events → {args.out}")
    print("\nDone. Restart the backend to serve the updated dataset.")


if __name__ == "__main__":
    main()

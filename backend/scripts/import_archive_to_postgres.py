"""
import_archive_to_postgres.py
─────────────────────────────────────────────────────────────────────────────
One-time importer: reads historical_events_2026.json and inserts each record
into core.events via psycopg2.

Usage:
    python scripts/import_archive_to_postgres.py
    python scripts/import_archive_to_postgres.py --input path/to/file.json
    python scripts/import_archive_to_postgres.py --dry-run

Requires:
    DATABASE_URL environment variable  (or .env at project root)
    psycopg2-binary  (pip install psycopg2-binary)
─────────────────────────────────────────────────────────────────────────────
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
    print("ERROR: psycopg2 is required.  pip install psycopg2-binary")
    sys.exit(1)

# ─────────────────────────────────────────────────────────────────────────────
# Configuration
# ─────────────────────────────────────────────────────────────────────────────

PROJECT_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_INPUT = PROJECT_ROOT / "historical_events_2026.json"

# GCN circulars are free-text and do not carry structured numeric measurements.
#
# These were previously written as 0.0 "so the row is accepted by the schema
# constraint" — but (0,0) is a *valid* sky position, so 279 archive rows ended
# up claiming to sit at the celestial origin with SNR 0 and FAR 0, and nothing
# downstream could tell them apart from real measurements.
#
# Migration 0011 made those columns nullable precisely so this importer can
# record UNKNOWN honestly. Do not reintroduce a numeric placeholder here.
NULL_FLOAT   = None
# Archive events were never received live, so there is no ingestion latency to
# measure. Migration 0017 dropped the NOT NULL (and the stray bigserial default)
# so this can be recorded as UNKNOWN instead of "arrived instantly".
NULL_LATENCY = None

# ─────────────────────────────────────────────────────────────────────────────
# SQL
# ─────────────────────────────────────────────────────────────────────────────

INSERT_SQL = """
INSERT INTO core.events (
    lab_id,
    event_id,
    event_type,
    observatory,
    detection_time,
    ra,
    dec,
    error_radius,
    snr,
    far,
    gal_lat,
    gal_lon,
    sun_distance,
    moon_distance,
    latency_us,
    lifecycle,
    alert_type,
    status,
    source,
    is_historical,
    source_catalog_id,
    gcn_url,
    is_retraction
)
VALUES (
    %(lab_id)s,
    %(event_id)s,
    %(event_type)s,
    %(observatory)s,
    %(detection_time)s,
    %(ra)s,
    %(dec)s,
    %(error_radius)s,
    %(snr)s,
    %(far)s,
    %(gal_lat)s,
    %(gal_lon)s,
    %(sun_distance)s,
    %(moon_distance)s,
    %(latency_us)s,
    %(lifecycle)s,
    %(alert_type)s,
    %(status)s,
    %(source)s,
    %(is_historical)s,
    %(source_catalog_id)s,
    %(gcn_url)s,
    %(is_retraction)s
)
ON CONFLICT (event_id)
DO NOTHING
"""

# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────

def load_env_db_url() -> str | None:
    """Read DATABASE_URL from environment or .env file at project root."""
    url = os.environ.get("DATABASE_URL")
    if url:
        return url
    env_file = PROJECT_ROOT / ".env"
    if env_file.exists():
        for line in env_file.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line.startswith("DATABASE_URL="):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    return None


def get_lab_id(cur: psycopg2.extensions.cursor) -> str:
    """Return the first lab ID from tenant.labs (used as required FK)."""
    cur.execute("SELECT id FROM tenant.labs ORDER BY created_at LIMIT 1;")
    row = cur.fetchone()
    if not row:
        raise RuntimeError("No lab found in tenant.labs — cannot import.")
    return str(row["id"])


def map_record(record: dict, lab_id: str) -> dict:
    """
    Map one historical_events_2026.json record to core.events columns.

    Required NOT NULL columns that GCN circulars don't carry receive safe
    placeholder values (0.0 / 0).  The is_historical=true flag distinguishes
    these rows from live Kafka events.
    """
    event_id       = record.get("eventId", "")
    event_type     = record.get("eventType", "OTHER")
    observatory    = record.get("observatory") or "Unknown"
    detection_time = record.get("detectionTime")
    lifecycle      = record.get("lifecycle") or "confirmed"
    source         = record.get("source") or "gcn_archive"
    is_historical  = bool(record.get("isHistorical", True))

    # circularId goes into source_catalog_id (text, closest matching column)
    circular_id = record.get("circularId")
    source_catalog_id = str(circular_id) if circular_id is not None else None

    # Subject line goes into gcn_url column as a short string annotation
    # (no dedicated summary/notes column exists in core.events schema v1)
    subject = record.get("subject") or None
    # Truncate to safe length to avoid inadvertently huge values
    if subject and len(subject) > 512:
        subject = subject[:512]

    # alert_type: derive from lifecycle for archive events
    lc = lifecycle.lower()
    if lc == "confirmed":
        alert_type = "CONFIRMED"
    elif lc == "preliminary":
        alert_type = "PRELIMINARY"
    elif lc == "initial":
        alert_type = "INITIAL"
    elif lc == "update":
        alert_type = "UPDATE"
    else:
        alert_type = "ARCHIVE"

    return {
        "lab_id":            lab_id,
        "event_id":          event_id,
        "event_type":        event_type,
        "observatory":       observatory,
        "detection_time":    detection_time,
        # Placeholder floats for NOT NULL numeric columns
        "ra":                NULL_FLOAT,
        "dec":               NULL_FLOAT,
        "error_radius":      NULL_FLOAT,
        "snr":               NULL_FLOAT,
        "far":               NULL_FLOAT,
        "gal_lat":           NULL_FLOAT,
        "gal_lon":           NULL_FLOAT,
        "sun_distance":      NULL_FLOAT,
        "moon_distance":     NULL_FLOAT,
        "latency_us":        NULL_LATENCY,
        "lifecycle":         lifecycle,
        "alert_type":        alert_type,
        "status":            lifecycle,   # mirror lifecycle into legacy status
        "source":            source,
        "is_historical":     is_historical,
        "source_catalog_id": source_catalog_id,
        "gcn_url":           subject,     # subject stored in gcn_url field
        "is_retraction":     False,
    }

# ─────────────────────────────────────────────────────────────────────────────
# CLI
# ─────────────────────────────────────────────────────────────────────────────

def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="Import historical_events_2026.json into core.events"
    )
    p.add_argument(
        "--input", type=Path, default=DEFAULT_INPUT,
        help=f"Input JSON file (default: {DEFAULT_INPUT.name})"
    )
    p.add_argument(
        "--dry-run", action="store_true",
        help="Parse and validate but do not write to database"
    )
    p.add_argument(
        "--batch-size", type=int, default=50,
        help="Records per commit batch (default: 50)"
    )
    return p.parse_args()

# ─────────────────────────────────────────────────────────────────────────────
# Main
# ─────────────────────────────────────────────────────────────────────────────

def main() -> None:
    args = parse_args()
    bar  = "=" * 60

    print(f"\n{bar}")
    print("  Transient Event Detection — GCN Archive -> PostgreSQL Importer")
    print(bar)
    print(f"  Input    : {args.input}")
    print(f"  Dry run  : {args.dry_run}")
    print(f"  Batch    : {args.batch_size}")
    print(f"{bar}\n")

    # ── 1. Read JSON ─────────────────────────────────────────────────────────
    if not args.input.exists():
        print(f"ERROR: Input file not found: {args.input}")
        sys.exit(1)

    with open(args.input, "r", encoding="utf-8") as fh:
        records: list[dict] = json.load(fh)

    total = len(records)
    print(f"[1/3] Read {total:,} records from {args.input.name}")

    if total == 0:
        print("  Nothing to import.")
        return

    # ── 2. Connect ───────────────────────────────────────────────────────────
    db_url = load_env_db_url()
    if not db_url:
        print("ERROR: DATABASE_URL not set and .env not found.")
        sys.exit(1)

    if args.dry_run:
        print(f"[2/3] [dry-run] Would connect to database")
        print(f"[3/3] [dry-run] Would insert up to {total:,} records")
        print(f"\n  Total read    : {total:>6,}")
        print(f"  Would insert  : {total:>6,}  (dry-run, no conflicts checked)")
        print(f"  Would skip    :      0  (estimated)")
        return

    try:
        conn = psycopg2.connect(db_url)
        conn.autocommit = False
        cur  = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    except Exception as exc:
        print(f"ERROR: Cannot connect to database: {exc}")
        sys.exit(1)

    print(f"[2/3] Connected to database")

    # ── 3. Insert ────────────────────────────────────────────────────────────
    print(f"[3/3] Importing {total:,} records (batch size: {args.batch_size}) ...")

    lab_id   = get_lab_id(cur)
    inserted = 0
    skipped  = 0
    errors   = 0
    batch    = 0

    for i, record in enumerate(records, 1):
        try:
            row = map_record(record, lab_id)
            cur.execute(INSERT_SQL, row)

            # rowcount == 0 means ON CONFLICT DO NOTHING fired (duplicate)
            if cur.rowcount == 0:
                skipped += 1
            else:
                inserted += 1

        except Exception as exc:
            conn.rollback()
            errors += 1
            event_id = record.get("eventId", f"index={i}")
            print(f"  WARN: Failed to insert {event_id}: {exc}")
            # re-open transaction after rollback
            continue

        # Commit in batches
        if i % args.batch_size == 0:
            conn.commit()
            batch += 1
            pct = i / total * 100
            print(f"  batch {batch}  ({i:>4}/{total}  {pct:4.0f}%)  "
                  f"inserted={inserted}  skipped={skipped}  errors={errors}")

    # Final commit for remainder
    conn.commit()
    cur.close()
    conn.close()

    # ── Summary ──────────────────────────────────────────────────────────────
    print(f"\n{bar}")
    print("  IMPORT COMPLETE")
    print(bar)
    print(f"  Total records read  : {total:>6,}")
    print(f"  Inserted            : {inserted:>6,}")
    print(f"  Skipped (duplicate) : {skipped:>6,}")
    print(f"  Errors              : {errors:>6,}")
    print(bar)


if __name__ == "__main__":
    main()

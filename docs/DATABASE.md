# DATABASE.md — Transient Event Detection

> Last updated: 2026-08-06

## Overview

- **RDBMS:** PostgreSQL 16 + PostGIS
- **ORM:** Drizzle ORM (type-safe, prepared statements)
- **Migrations:** Drizzle programmatic migrator (`lib/db/run-migrate.mjs`)
- **Extensions:** `postgis`, `ltree`, `pgvector` (hnsw), TimescaleDB (hypertable on `event_detections`)
- **Schemas:** 8 namespaces across 26 tables

## Schemas

### `core` — Astrophysical Event Data

#### `core.events` (primary table)

| Column | Type | Notes |
|---|---|---|
| `id` | bigserial PK | Auto-increment |
| `lab_id` | uuid FK→tenant.labs | Multi-tenant isolation |
| `event_id` | text UNIQUE | GCN event identifier (upsert target) |
| `event_type` | text | GRB / GW / FRB / NU |
| `detection_time` | timestamptz | Original observatory time |
| `ra` / `dec` | float8 | Right ascension / declination [°] |
| `sky_position` | geography(POINT) | Computed via trigger: ST_MakePoint(ra,dec) |
| `error_radius` | float8 | Localization uncertainty [arcmin] |
| `snr` | float8 | Signal-to-noise ratio |
| `far` | float8 | False alarm rate [Hz] |
| `fluence` | float8 nullable | GRB only [erg/cm²] |
| `t90` | float8 nullable | GRB duration [s] |
| `dm` | float8 nullable | FRB dispersion measure [pc/cm³] |
| `chirp_mass` | float8 nullable | GW chirp mass [M☉] |
| `luminosity_distance` | float8 nullable | GW distance [Mpc] |
| `gal_lat` / `gal_lon` | float8 | Galactic coordinates |
| `sun_distance` | float8 | Angular distance from Sun [°] ⚠️ hardcoded 90° |
| `moon_distance` | float8 | Angular distance from Moon [°] ⚠️ hardcoded 90° |
| `latency_us` | bigint | μs from detection to API receipt |
| `lifecycle` | text | preliminary / initial / update / confirmed |
| `alert_type` | text nullable | Raw alert_type from source |
| `classification_tier` | text nullable | GOLD / BRONZE (IceCube) |
| `observatory` | text | Source instrument name |
| `is_retraction` | bool | Retraction flag |
| `source` | text | kafka / bootstrap / historical |
| `is_historical` | bool | Bootstrap seed marker |
| `revision_count` | int | Update counter |
| `latest_revision` | text nullable | Most recent alert_type string |
| `ingested_by` | uuid FK→users nullable | — |
| `created_at` / `updated_at` | timestamptz | Auto-managed |

**Indexes:**
- `(id)` PK
- `(event_id)` UNIQUE (upsert target)
- `(sky_position)` GiST — PostGIS cone search
- ⚠️ Missing: `(lab_id)`, `(detection_time DESC)`, `(event_type)`, `(lifecycle)`, `(source)`

#### `core.event_detections`
TimescaleDB hypertable partitioned by `detected_at`. Stores multi-observatory detections per event. Columns: `event_id`, `lab_id`, `observatory_id`, `detected_at`, `ra`, `dec`, `snr`, `far`, `raw_payload` (jsonb).

#### `core.event_localizations`
HEALPix sky map metadata. Key columns: `fits_url`, `nside`, `area_50_deg2`, `area_90_deg2`, `vol_50_mpc3`, `vol_90_mpc3`, `lineage` (ltree), `is_latest`.

#### `core.event_classifications`
GW CBC probability outputs. Columns: `classifier`, `prob_bns`, `prob_nsbh`, `prob_bbh`, `prob_mass_gap`, `prob_terrestrial`, `has_ns`, `has_remnant`.

#### `core.event_annotations`
Threaded comments per event. Self-referential `parent_id`, `tags` (text[]), `is_pinned`, soft delete via `deleted_at`.

#### `core.event_embeddings`
pgvector semantic embeddings (schema defined, unpopulated). `embedding` column is 1536-dim. HNSW index defined: `CREATE INDEX USING hnsw (embedding vector_cosine_ops) WITH (m=16, ef_construction=64)`.

#### `core.event_followup_requests`
Telescope observation requests. `priority` (normal/urgent), `status` (pending/accepted/rejected), `exposure_time_s`, `filter_band`, `expires_at`.

### `tenant` — Multi-tenancy

| Table | Purpose |
|---|---|
| `tenant.labs` | Lab/organization. `slug` UNIQUE, `plan` (free/pro/enterprise), `max_users`, `settings` jsonb |
| `tenant.lab_members` | Composite PK `(lab_id, user_id)`, `role` (researcher/admin/viewer) |
| `tenant.lab_invitations` | Email invitations with expiry |
| `tenant.event_bookmarks` | User-scoped bookmarks with personal notes |

### `identity` — Authentication

| Table | Purpose |
|---|---|
| `identity.users` | Local/Google/ORCID users. `email` UNIQUE, `provider`, `orcid_id`, `password_hash` |
| `identity.sessions` | Token sessions (schema only — JWT is stateless in practice) |
| `identity.api_keys` | Hashed scoped API keys (schema only, no routes) |

### `catalog` — Observatory Metadata

- `catalog.observatories` — instrument registry
- `catalog.observatory_capabilities` — per-instrument capability config

### `alerts`, `metrics`, `audit` (schema-only)

- `alerts.alert_subscriptions` — user alert preferences (email/push/webhook)
- `metrics.event_metrics` — aggregate statistics
- `audit.audit_logs` — change log (no trigger wired yet)

## Migrations

Location: `lib/db/migrations/`
Runner: `lib/db/run-migrate.mjs` (programmatic, robust exit codes)

Run automatically by the `migrate` Docker service on every `docker compose up`.
Run manually: `docker compose run --rm migrate`

**Journal:** `lib/db/migrations/meta/_journal.json` — tracks applied migrations.

## Known Issues

| Issue | Impact |
|---|---|
| Missing `lab_id` index on `core.events` | High — all queries filter by lab_id |
| Missing `(detection_time DESC)` index | Medium — time-ordered list queries |
| Missing `(orcid_id)` index on `identity.users` | Medium — ORCID login lookup |
| Missing `(email, status)` index on `tenant.lab_invitations` | High — checked on every registration |
| `sun_distance` / `moon_distance` hardcoded to 90° | Medium — scientific accuracy |
| `core.event_embeddings.embedding` stored as text not `vector(1536)` | Medium — breaks pgvector ops |

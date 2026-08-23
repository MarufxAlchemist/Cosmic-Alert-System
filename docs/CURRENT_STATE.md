# CURRENT_STATE.md — Transient Event Detection

> Last updated: 2026-08-16

## Development Status

**Active development / pre-production.**
Core data pipeline, backend infrastructure, and primary dashboard are functional.
Collaboration features have backend routing wired but minimal frontend integration.

---

## Completed Features ✅

| Feature | Location |
|---|---|
| GCN Kafka consumer (Python FastAPI + asyncio) | `backend/app/gcn/` |
| Scientific alert filter with per-source quality gates | `artifacts/api-server/src/lib/alertFilter.ts` |
| Node.js Express + WebSocket API server | `artifacts/api-server/src/index.ts` |
| PostgreSQL schema (8 namespaces, 26 tables) | `lib/db/src/schema/` |
| Drizzle ORM migrations | `lib/db/migrations/` |
| Bootstrap seeding with historical event replay | `artifacts/api-server/src/lib/bootstrap.ts` |
| React dashboard with live event feed | `artifacts/astro-sentinel/src/pages/dashboard.tsx` |
| Science mode panel with tier/lifecycle badges | `artifacts/astro-sentinel/src/components/SciencePanel.tsx` |
| JWT authentication | `artifacts/api-server/src/middlewares/auth.ts` |
| Google OAuth login | `artifacts/api-server/src/routes/auth.ts` |
| ORCID OAuth login | `artifacts/api-server/src/routes/auth.ts` |
| Multi-tenant lab/team system (backend) | `artifacts/api-server/src/routes/team.ts` |
| Event bookmarks (backend) | `artifacts/api-server/src/routes/bookmarks.ts` |
| Event discussion threads (backend) | `artifacts/api-server/src/routes/discussions.ts` |
| Filter report endpoint | `artifacts/api-server/src/routes/filterReport.ts` |
| Docker Compose single-command setup | `docker-compose.yml` + 4 root Dockerfiles |
| GitHub push secret scanning fix (`.env` untracked) | `.gitignore` |
| **Phase 5.1: Email notification infrastructure** | `src/notifications/` (6 modules) |
| **Phase 5.2: Scientific Priority Classification Engine** | `src/science/priorityEngine/` (5 modules) |
| **Phase 5.3: Scientific Email Template System** | `src/notifications/templates/` (4 modules) |
| **Phase 5.4: Multi-Messenger Correlation Engine** | `src/science/correlationEngine/` (6 modules) |
| **Phase 5.5: Intelligent Notification Deduplication** | `src/notifications/deduplicationEngine/` (5 modules) |
| **Phase 5.6: AI Scientific Summary Generation** | `src/science/summaryEngine/` (2 modules) |
| **Phase 5.6: Correlation-Aware Scientific Notifications** | `src/notifications/templates/eventTemplate.ts` |
| **WeChat channel (WeCom group robot)** — provider abstraction, AES-256-GCM credential storage, SSRF-pinned transport, config API, dispatcher with retry/rate-limit/idempotency, delivery history UI. See [WECHAT_NOTIFICATIONS.md](WECHAT_NOTIFICATIONS.md) | `artifacts/api-server/src/notifications/providers/`, `routes/notificationsWechat.ts` |
| Test suite (vitest, 103 tests) + ESLint with `react-hooks/rules-of-hooks` | `artifacts/api-server/vitest.config.ts`, `artifacts/astro-sentinel/eslint.config.js` |

---

## Incomplete / Stub Features ⚠️

| Feature | Status | Location |
|---|---|---|
| **WeChat end-to-end delivery to Tencent** | Every layer up to the HTTP boundary is built and tested, but **no message has reached WeCom's servers.** Needs a real robot webhook from the WeCom console — see [WECHAT_NOTIFICATIONS.md](WECHAT_NOTIFICATIONS.md). Treat as unproven in production until then. | `providers/wechat/` |
| QQ channel | Deliberately not implemented. Tencent has no official API for messaging a personal QQ account from a third party; the group/channel bot route needs QQ Open Platform registration and review. The UI states the reason. | `WeComConfigPanel.tsx` |
| External links (GCN, ALADIN, ESASky, TNS) | Non-functional UI stubs | Frontend components |
| Telescope follow-up request UI | Backend schema complete, no frontend | `routes/team.ts` schema |
| Event localization FITS map viewer | Schema complete, no UI | — |
| pgvector semantic similarity search | Schema defined, no population logic | `core.event_embeddings` |
| `byObservatory` in `/events/stats` | Always returns `[]` | `routes/events.ts` |
| `event_updated` WebSocket handling | Frontend doesn't process revision updates live; the per-event revision history IS recorded and shown (Phase 6) | `useAstroWebSocket.ts` |
| `NU` (neutrino) count in stats | Not included in `byType` response | `routes/events.ts` |

---

## Known Bugs 🐛

| Bug | Severity | Location |
|---|---|---|
| `byObservatory` always `[]` | Medium | `artifacts/api-server/src/routes/events.ts` |
| ~~`sun_distance` / `moon_distance` hardcoded to `90°`~~ — **misdiagnosis.** Astropy calc existed but (a) used mismatched ICRS/GCRS frames, wrong by up to ~150°, and (b) fell back to a fabricated `90.0`. Both fixed; all 304 rows recomputed. | Fixed 2026-08-14 | `backend/app/gcn/normalizer.py` |
| ~~`_safe_float(..., 0.0)` coerces missing **source** measurements to `0.0`~~ — 92% of the archive claimed to sit at RA 0, Dec 0. Root cause was `import_archive_to_postgres.py` writing `NULL_FLOAT = 0.0` *because the columns were NOT NULL*. | Fixed 2026-08-16 | `normalizer.py`, migrations 0011/0012 |
| ~~IceCube **signalness** (probability 0–1) stored in the **`snr`** column (significance in σ)~~ — different quantities, made cross-messenger SNR comparison meaningless | Fixed 2026-08-16 | `normalizer.py`, `core.events.signalness` |
| ~~`core.event_correlations` declared in schema and written by `repository.ts` but **never created by any migration**~~ — `saveCorrelation()` swallowed every failure | Fixed 2026-08-16 | migration 0012 |
| ~~Correlation scorer coerced `null` position to `0`, yielding a perfect 0° spatial match~~ — could manufacture multi-messenger associations | Fixed 2026-08-16 | `correlationEngine/scorer.ts` |
| ~~FAR of 0 rendered as "1 per Infinity years"~~ — a 1/0 artifact shown as a scientific statement | Fixed 2026-08-16 | `formatters.ts` |
| 279 archive events remain scientifically empty (GCN circulars are free text; measurements were never extracted). Now reported honestly rather than fabricated: they carry UNKNOWNs, a lower-bound interest score, and are never passed to the AI as zeros. | Medium | `core.events` where `source='gcn_archive'` |
| ~~`latency_us` `NOT NULL` with a `0` placeholder — 279 archive events displayed "Latency 0 µs"~~ — the column was also declared `bigserial`, so it carried a `nextval()` DEFAULT: any INSERT omitting it would receive 1, 2, 3 µs as a "measured" latency. Sequence dropped, column nullable, placeholders → NULL. | Fixed 2026-08-17 | migration 0017, `import_archive_to_postgres.py`, `normalizer.py` |
| `backend/app/ingest/circulars.py` + `gracedb.py` still write `snr=0.0`, `far=0.0`, `sunDistance=90.0`, `moonDistance=90.0` (and `ra/dec=0.0` in gracedb). Standalone scripts, not in the live ingest path, so the Phase 2 sweep missed them — but they reintroduce the hardcoded-90° and null-island bugs if run. | Medium | `backend/app/ingest/` |
| `eventIngestion.ts` generates **random** sun/moon distances (`randomBetween(30,150)`) | Low (dead stub) | `artifacts/api-server/src/lib/eventIngestion.ts` |
| `kafka_connected` in heartbeat always `true` even when disconnected | Low | Python WS manager |
| `eventIngestion.ts` is a no-op stub but still imported | Low | `artifacts/api-server/src/lib/eventIngestion.ts` |
| Both `bcrypt` and `bcryptjs` installed (only `bcryptjs` used) | Low | `artifacts/api-server/package.json` |
| `NU` events not counted in stats `byType` | Low | `routes/events.ts` |
| ~~`eventCorrelations` missing from `@workspace/db` barrel export, breaking API server Docker build~~ | Fixed 2026-08-09 | `lib/db/src/schema/index.ts` |
| ~~`/team/invitations` routes missing entirely, "Send Invite" always failed with Network error~~ | Fixed 2026-08-13 | `artifacts/api-server/src/routes/team.ts` |
| ~~`tenant.event_bookmarks` table missing from DB (migration 0002 never applied) — bookmarking silently no-opped~~ | Fixed 2026-08-14 | `lib/db/migrations/0002_event_bookmarks.sql` |
| ~~Event Archive grid didn't scroll (missing `min-h-0` on flex child)~~ | Fixed 2026-08-14 | `artifacts/astro-sentinel/src/pages/events.tsx` |

---

## Recent Changes (2026-08-16)

> Note on numbering: the "Phase 5.x" entries below belong to the earlier
> notification workstream. The "Scientific Intelligence Phase N" entries are the
> separate Scientific Event Intelligence and Validation Layer.

- **Scientific Intelligence Phase 7 — Research Interest & AI Guardrails**
  (spec sections 40-44):
  - `app/science/ai_context.py` — the model sees only measured values with
    provenance; every unknown is stated as unknown. **Fixed:** the summary path
    coerced absent measurements to 0, so 279 unlocalized events would have been
    described to the model as sitting at RA=0/Dec=0 and 294 as having FAR=0 Hz
    (= infinite significance). The anti-hallucination prompt was being defeated
    by its own input.
  - `verify_output()` + `aiGuard.ts` — generated text is screened for numeric
    claims never supplied; unverifiable output is withheld, and a context that
    cannot be built means the summary is skipped, not faked.
  - `app/science/interest.py` + migration `0016` + `ResearchInterestPanel.tsx`
    — the third score, kept strictly distinct: quality = is the data
    trustworthy, priority = is it urgent, interest = is it worth studying.
  - **Fixed:** events with no applicable rule scored 0 and read as MINIMAL;
    they now return UNASSESSED, because "found little" ≠ "nothing to look at".
  - 331 backend tests pass. Interest bands: LOW 296 / MODERATE 3 / UNASSESSED 5.
- **Scientific Intelligence Phase 6 — Revision Intelligence & Scientific Delta Detection**
  (spec sections 27-28):
  - `app/science/revisions.py` — distinguishes a *refinement* (position moves
    within the combined uncertainties) from an *inconsistency* (moves far
    outside them, ERROR at 3σ). Localization radii are compared only when both
    notices state the same containment convention.
  - Migration `0015` — append-only `core.event_revisions`: one row per notice
    with its snapshot and the delta against its predecessor. Revisions
    previously overwrote `core.events` in place, destroying the prior state.
  - `POST /api/science/revision-delta` (Python) + `revisionRecorder.ts` (Node):
    the api-server knows the previous state, but the delta rules stay in Python
    and exist exactly once.
  - `GET /events/:id/revisions` + `RevisionTimeline.tsx`, shown in both modes.
  - Fixed: `changeDetector.ts` treated a *lost* localization (radius 0 =
    UNKNOWN since Phase 2) as a **perfect** one and fired "LOCALIZATION_IMPROVED".
  - 296 backend tests pass. Archive events predate tracking and have no history;
    the UI states that rather than implying they were never revised.
- **Scientific Intelligence Phase 5 — Uncertainty, Units, Cosmology, Derived Science**
  (spec sections 19-24, 33-34):
  - `app/science/units.py` — canonical units across 10 dimensions. A unit is
    never guessed, and a cross-dimension conversion is refused rather than
    performed.
  - `app/science/uncertainty.py` — first-order propagation (independence stated,
    not hidden) and localization containment semantics: 90% containment is
    2.146σ in 2-D but 1.645σ in 1-D, and 68% of a skymap is 1.515σ, not 1σ.
  - `app/science/cosmology.py` — explicit named cosmology stamped onto every
    derived value. `ASTROSENTINEL_COSMOLOGY` (Planck18 default). An unknown
    model derives nothing instead of falling back.
  - `app/science/observability.py` — altitude/azimuth/airmass for a configured
    site only (`ASTROSENTINEL_SITE_LAT`/`_LON`). Unconfigured ⇒ UNKNOWN with the
    reason; never computed from an invented location.
  - `app/science/derivations.py` + migration `0014` + `DerivedSciencePanel.tsx`
    — derived quantities persisted and rendered with method, assumptions and
    propagated uncertainty; UNKNOWN shown in words with what's missing.
  - Fixed: GW `area_90` (deg², a credible area) was stored as `errorRadius`
    (arcmin, an angle); the sky viewer labelled every circle "1σ" regardless of
    what the source said; live ingestion could drop alerts on the new CHECK
    constraints.
  - 257 backend tests pass. Archive backfilled (304 events) — all cosmological
    quantities are UNKNOWN because the archive contains **zero redshifts**.
- **Phase 5.6 — Correlation-Aware Scientific Notifications:**
  - Integrated Multi-Messenger Correlation Engine with the notification pipeline in `eventTemplate.ts`.
  - Added candidate events listing to the correlation block for better scientific context.
  - Implemented logic to completely suppress the correlation section when confidence is "NONE", avoiding clutter in emails without valid correlations.
- **Phase 5.6 — AI Scientific Summary Generation:**
  - Added `ai_scientific_summaries` caching table linked by event ID and payload hash
  - Added strict JSON-only output prompt engine with zero-hallucination constraint
  - Engine automatically uses `gemini-2.5-flash` with a 15-second timeout via the new provider abstraction
  - Wired into `notificationService.ts` before email build step
  - If generation fails or times out, safely falls back to rendering raw data in the email
- **Phase 5.5 — Intelligent Notification Deduplication Engine:**
  - Added `alerts.notification_history` audit table for per-event GCN revision tracking
  - Engine parses `DEDUP_SCORE_DELTA`, `DEDUP_LOCALIZATION_PCT`, and `DEDUP_SEND_ON_CONFIRMED`
  - `changeDetector.ts` cleanly identifies meaningful state upgrades across revisions
  - Supresses generic INITIAL/UPDATE GCN traffic; always fires on Priority increases, Correlation upgrades, or Localization leaps
  - Wired into `notificationService.ts` as an explicit gate between correlation and email generation
- **Phase 5.4 — Multi-Messenger Correlation Engine:**
  - `science/correlationEngine/types.ts` — All types (CorrelationInput, CorrelationResult, CorrelationMatch, CorrelationEvent, CorrelationConfidence) matching `docs/correlation.txt` I/O schema
  - `science/correlationEngine/windows.ts` — All configurable temporal/spatial thresholds with astrophysical justification (GW170817/GRB 170817A cited)
  - `science/correlationEngine/pairingRules.ts` — 6 physically motivated event type pairings (GW+GRB=40, GW+NU=30, GW+FRB=20, GRB+NU=25, GRB+FRB=10, NU+FRB=8)
  - `science/correlationEngine/scorer.ts` — Haversine angular separation, temporal score (linear falloff to window edge), spatial score, pairing rule lookup
  - `science/correlationEngine/engine.ts` — Orchestrator: scores all candidates, picks best temporal match, maps score → HIGH/MEDIUM/LOW/NONE, generates narratives
  - `science/correlationEngine/index.ts` — Public re-exports
  - `notifications/notificationService.ts` — `fetchCandidateEvents()` DB helper + `correlate()` call wired between priority gate and email build
  - `notifications/notificationTemplates.ts` — `correlationResult` field added to `TemplateInput`
  - `notifications/templates/eventTemplate.ts` — `correlationSection()` replaces static placeholder; follow-up section uses real recommendation when confidence ≠ NONE
  - `.env.example` — 11 new `CORR_*` env vars with justification comments
- **Phase 5.3 — Scientific Email Template System:** 7-section responsive email (dark mode, Outlook, mobile, print)
- **Phase 5.2 — Scientific Priority Engine:** P0-P3 scoring (11 rules, all thresholds configurable)
- **Phase 5.1 — Email Notification Infrastructure:** SMTP/Resend/SendGrid, 3-retry queue, audit log

---

## Priorities (Next Tasks)

1. Configure email provider in `.env` (`EMAIL_PROVIDER=smtp|resend|sendgrid`) and test a live email
2. Fix `byObservatory` in `/events/stats` (always returns `[]`)
3. Fix `event_updated` WebSocket handling in `useAstroWebSocket.ts`
4. Remove `eventIngestion.ts` dead code (no-op simulator)
5. Write unit tests for `src/science/priorityEngine/` scoring rules (11 pure functions)
6. Write unit tests for `src/science/correlationEngine/` (scorer, engine, pairingRules)
7. Write unit tests for `src/notifications/deduplicationEngine/` (changeDetector, engine)
8. Wire telescope follow-up request UI
9. Add `lab_id` index on `core.events` (missing, high performance impact)

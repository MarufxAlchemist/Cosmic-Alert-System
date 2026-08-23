# CHANGELOG_AI.md — Transient Event Detection

AI coding session log. Newest entries at top. Never rewrite previous entries.

---

## 2026-08-16 — Phase 4: Per-messenger validators (GRB / GW / FRB / NU)

### New package: `backend/app/science/messengers/`
Modular per spec section 45 — adding a messenger means adding a module and one entry in `VALIDATORS`, with no change to the universal validators or the quality score. Dispatched via `check_messenger_specific`, which inherits the same per-check isolation so a messenger rule can never break ingestion. Einstein Probe (`EP`) routes to the GRB checks, which apply directly to high-energy transients.

### What each module refuses to do
The scientific content of this layer is as much in the refusals as the checks.

- **`grb.py`** — classifies T90 duration (Kouveliotou 1993, 2 s) but *never* asserts a progenitor: the label always carries the caveat that the split is statistical, detector-dependent and heavily overlapping. Derives rest-frame T90 and Epeak **only** when a redshift is present. **E_iso is never computed** — it needs a bolometric k-correction over a defined rest-frame band and an explicit cosmology, so it stays UNKNOWN with the reason recorded.
- **`gw.py`** — checks the exhaustive `{BNS, NSBH, BBH, Terrestrial}` partition sums to 1, and explicitly **does not normalise an incomplete set**. `HasNS`/`HasRemnant` are marginal probabilities over the same event and are excluded from that sum rather than double-counted. Cross-validates the reported chirp mass against component masses via `Mc = (m1·m2)^{3/5}/(m1+m2)^{1/5}` (>5% disagreement is an ERROR), flags `HasNS` high with two black-hole-mass components, catches inverted credible areas, and labels any distance-accompanying redshift MODEL-DEPENDENT so it is never read as spectroscopic.
- **`frb.py`** — validates the `DM_total = DM_MW + DM_host + DM_IGM` decomposition and errors when `DM_MW > DM_total`. Since no NE2001/YMW16 electron-density model is deployed, `DM_MW` and the extragalactic excess stay UNKNOWN unless the notice supplies them. **No redshift is derived from DM** — the Macquart relation's sight-line scatter makes a per-event z a model estimate, not a measurement.
- **`neutrino.py`** — **never guesses an energy unit.** GeV/TeV/PeV differ by factors of 1000, so an unlabelled energy is reported as uninterpretable rather than converted; an unrecognised unit is an ERROR, not an assumption. Keeps signalness (a probability) strictly distinct from SNR (sigma) — the Phase 2 conflation — and flags GOLD/BRONZE tiers inconsistent with their signalness thresholds, and cascades carrying track-like localization.

### Quality-score attribution
New codes mapped to the correct components rather than defaulting: localization findings to `coordinate_validity`, messenger-specific absences to `completeness`, internal inconsistencies (chirp-mass, HasNS, DM decomposition, tier mismatch) to `cross_field`. Verified: a bad GW partition now floors `cross_field`, not `physical_validity`.

### Three Phase 3 tests failed — correctly
Adding the FRB validator broke `test_clean_event_produces_no_diagnostics` and two others, because the Phase 3 fixture was an `eventType: "FRB"` carrying **no DM** — which the new validator rightly flags. Fixed by making the fixture complete (adding `dm`) rather than loosening the assertion, and renamed the test to `test_clean_event_produces_no_findings_against_the_data`: INFO diagnostics such as "redshift not derived from DM" are legitimate output recording a deliberate refusal, so "clean" means nothing at WARNING or above, not silence.

### Backfill over the archive
Re-ran with messenger validators active. New findings across 304 events: `grb_t90_missing` 270, `frb_dm_decomposition_unavailable` 17, `frb_redshift_not_derived` 17, `nu_signalness_missing` 9, `grb_fluence_band_missing` 5. Distribution tightened from PASS 10 to PASS 2 — the messenger checks correctly identify that most archive events lack their defining observable.

### Verification
- **167 backend tests passing** (55 new in `test_messengers.py`)
- All 6 routes x both Science Mode states — zero console errors
- API confirmed serving messenger diagnostics (`grb_t90_missing` on archive GRBs)

---

## 2026-08-16 — Phase 3: Scientific validation, diagnostics and quality score

### New module: `backend/app/science/`
Validation lives in Python beside the normalizer so it runs on the synchronous ingestion path (spec section 41) with the normalized values and astropy already available. It is separate from `alertFilter.ts`, which is an accept/reject gate on *raw* payloads — validation never rejects or mutates, it only describes.

- `diagnostics.py` — `Level` (INFO/NOTICE/WARNING/ERROR/CRITICAL), `Diagnostic`, `ValidationReport`. Every finding carries a stable `code` and the `field` it concerns, so the UI and downstream analysis group findings without parsing prose.
- `validators.py` — seven check groups: coordinates, galactic, separations, time, measurements, cross-field, and source sanitization.
- `quality.py` — the transparent score.

### Design decisions worth recording
- **Absence is not an error.** Missing values are WARNINGs; only physically impossible ones are ERRORs. A false ERROR is worse than a missed WARNING because it trains researchers to ignore the panel.
- **`check_source_sanitization` closes a real hole.** The normalizer discards impossible values (SNR = -5 becomes null), which is right for storage but made a *broken notice* indistinguishable from one that simply omitted the field. This check re-inspects the retained raw payload and reports `source_value_impossible` / `source_value_unparseable` as ERRORs, so the two cases stay distinct.
- **Isolated checks.** A validator that raises produces a CRITICAL diagnostic instead of aborting; one bad rule can never suppress the others or drop an alert (spec section 48).

### Quality score — three bugs found and fixed during development
The first implementation scored an event with no position and no measurements at **81/100 "PARTIAL"** — precisely the "aesthetically pleasing score without scientific justification" the spec forbids. Three corrections:

1. **Vacuous credit.** `physical_validity` scored 100 for having no values to be wrong about. Components with nothing to assess are now marked N/A and excluded, with the remaining weights renormalised. That event now scores **46 POOR**.
2. **Missing position under-penalised.** An event that cannot be pointed at is unusable for follow-up, so `position_missing` now floors `coordinate_validity` rather than deducting 35.
3. **Score contradicting its own verdict.** An out-of-range declination scored 75 "PARTIAL" while validation status already read FAIL. Any ERROR now caps the score at 40 and forces grade FAIL; a WARNING prevents the grade reading "PASS".

Every deduction is itemised with its code and reason, so any number shown to a researcher is traceable to the rule that produced it.

### Persistence and plumbing
- `lib/db/migrations/0013_event_validation.sql` — `validation` + `quality` JSONB, plus denormalised `quality_score` (smallint, CHECK 0-100) and `validation_status` (CHECK PASS/WARNING/FAIL/UNKNOWN) with partial indexes for "show me events that failed" and "worst quality first". Registered in the journal.
- `kafkaConsumer.ts` persists all four and refreshes them on revision upsert; `formatEvent()` exposes them; generated types updated.
- `correlation-agent.ts` input type made nullable — the LLM must see UNKNOWN rather than a fabricated stand-in (spec section 42). The existing prompt already instructs "if a field is null or absent, do not assume a value".

### Backfill over the existing archive
`backend/scripts/backfill_validation.py` (dry-run by default) re-uses the same rules rather than reimplementing them. Result across 304 events:

```
status : PASS 10, WARNING 294
grade  : PASS 10, PARTIAL 15, POOR 279
score  : min 46, median 46, max 100
top    : far_missing 294, error_radius_missing 294, position_missing 279,
         snr_missing 214, snr_not_applicable 65
```

**Zero ERROR-level findings** — an independent confirmation that the Phase 1/2 cleanup left no physically impossible values behind. The 279 POOR are exactly the position-less archive rows.

### Frontend
`ValidationPanel.tsx` — status badge, quality score with colour-coded bar, per-finding cards (level, code, field, message), and an expandable score breakdown showing every component's weight, score, N/A state and itemised deductions. Rendered on the event detail page under Science Mode. Events predating Phase 3 read "Not assessed" rather than implying they passed.

### Verification
- 112 backend tests passing (54 new in `test_validation.py`)
- All 6 routes x both Science Mode states — zero console errors
- API confirmed serving `validationStatus` / `qualityScore` / full reports

---

## 2026-08-16 — Scientific Integrity Phase 2: source measurements + provenance

### Root cause confirmed in writing
`backend/scripts/import_archive_to_postgres.py:44` contained:

```python
NULL_FLOAT = 0.0
# Placeholder floats for NOT NULL numeric columns
"ra": NULL_FLOAT, "dec": NULL_FLOAT, "snr": NULL_FLOAT, ...
```

The importer never attempted to extract measurements — it wrote zeros *because the columns were NOT NULL*, and the comment says so. This is the same mechanism as migration 0010: **the constraint caused the fabrication.** 279 of 304 rows (92%) carried `ra=0, dec=0, snr=0, far=0, error_radius=0` simultaneously. All of them came from `source='gcn_archive'`; live `kafka` and `bootstrap` rows were unaffected.

Because (0,0) is a *valid* celestial coordinate, nothing downstream flagged it — the sky map plotted 279 events at the origin and the correlation engine saw them as perfectly coincident.

### Migrations (applied to live DB)
- `0011_nullable_source_measurements.sql` — dropped NOT NULL on `ra`, `dec`, `error_radius`, `snr`, `far`; retired placeholders field-by-field (not a blanket rule: some CHIME FRB rows have a genuine position but fabricated FAR); and **decontaminated the derived geometry Phase 1 had computed from the fabricated (0,0) positions** — derived-from-unknown must itself be UNKNOWN.
- `0012_signalness_and_provenance.sql` — added `core.events.signalness`; CHECK constraints so a fabricated value now fails at write time (`ra` range, `dec` range, `snr>0`, `far>0`, `error_radius>0`, sun/moon in [0,180], and derived-requires-position); created `core.event_correlations` (declared in the Drizzle schema and written by `repository.ts`, but **no migration ever created it** — `saveCorrelation()` swallows errors, so every persist silently failed); created `core.event_value_provenance`.

Post-state: 304 rows — 25 with a real position, 279 honestly UNKNOWN, 0 at the origin, 0 unphysical, 0 contaminated derived values.

### Signalness is not SNR
`normalizer.py` wrote IceCube **signalness** (a probability in [0,1] that the event is astrophysical) into the **`snr`** column (a significance in sigma). Different quantities, different units, not comparable — this made any cross-messenger SNR comparison meaningless. Signalness now has its own column with a `[0,1]` CHECK; `snr` is NULL for IceCube.

### Normalizer
- Added `_measured()` (absent -> None) and `_positive_measured()` (also rejects <= 0, for SNR/FAR/radius where zero is physically meaningless). 31 call sites converted off `_safe_float`.
- The `base` defaults dict — used precisely when a parser *raises* — was seeding `ra/dec/snr/far = 0.0`. Now None.
- Removed a hardcoded `loc_error` default of `3.0` arcmin.
- IceCube `max(ra_err, dec_err)` no longer collapses to 0 when neither is reported.
- `import_archive_to_postgres.py`: `NULL_FLOAT = None`.

### Spurious-correlation guard
`science/correlationEngine/scorer.ts` called `angularSeparationDeg(primary.ra, ...)` unguarded. JavaScript coerces `null` to `0` inside the haversine, yielding separation `0°` — a *perfect* spatial match — which would manufacture multi-messenger "associations" between events that simply have no position. `scorePair()` now returns a zero score with explicit reasoning when either position is unknown.

### Provenance
`core.event_value_provenance` records, per (event, parameter): source classification, confidence, quality, unit, uncertainty, method, input fields, software version, and assumptions. Populated for all 100 derived values across the 25 positioned events (`astropy 6.1.4`, inputs `ra`/`dec`/`detection_time`).

### API / frontend
- `ra`, `dec`, `errorRadius`, `snr`, `far` nullable through OpenAPI, zod, generated types, WS types; `signalness` added.
- New formatters: `formatMeasured()`, `formatExp()`, `formatFarInterval()`. The last replaces an unguarded `1 / far` that rendered **"1 per Infinity years"** — a division-by-zero artifact displayed as a scientific statement.
- `SkyMap` skips position-less events rather than drawing them at (0,0).
- `generateSummary()` narrative no longer asserts a position it does not have.

### Tests
`backend/tests/` — **58 passing** (28 Phase 1 + 30 Phase 2). Covers UNKNOWN-not-zero, parse-failure behaviour, FAR-of-zero, and the signalness/SNR separation.

### Post-verification fixes (found by running the app, not by review)
Static review and a passing `vite build` both missed these — Vite does not type-check, so an undefined identifier ships as a runtime `ReferenceError`.

- **`formatDerived` imported nowhere it was used.** The Phase 1 batch added `formatDerived(...)` calls to `BasicInfo.tsx`, `AladinMetadataPanel.tsx` and `dashboard.tsx` but the follow-up import pass only added `formatMeasured`/`formatExp`. Mission Control crashed with `ReferenceError: formatDerived is not defined`. Added a repo-wide audit comparing formatter *usage* against *imports* per file.
- **`RightPanel` crashed on null.** `event.ra.toFixed(6)`, `event.dec.toFixed(6)` and `event.far.toExponential(2)` were still unguarded; my earlier grep pattern missed them.
- **A second correlation implementation was unguarded.** `computeCorrelations()` in `routes/events.ts` is independent of `correlationEngine/scorer.ts`; only the latter had the null-position guard. `/events/19047/correlations` was returning `angularSeparationDeg: 0, spatialScore: 1` — a *perfect* spatial match between two events that both have no position. Both implementations now carry the guard.
- **Fabricated spectral physics removed.** `DerivedParameters.tsx` computed `Ep` (spectral peak energy, keV) as `event.snr * 9.2` — there is no physical relationship between a signal-to-noise ratio and a peak energy, and the comment admitted the field "wasn't added to schema". This rendered invented measurements (SNR 14.7 -> "135 keV") as though observed. Now UNKNOWN until a real spectral fit is parsed.
- **Sky-atlas links no longer point at (0,0).** ALADIN/ESASky/TNS links are omitted when the event has no position, rather than sending a researcher to the celestial origin.

Verified: all 6 routes x both Science Mode states load with zero console errors.

### Live ingestion path — the fixes did NOT initially reach new events
Phases 1-2 corrected the Python normalizer and the historical archive, but the **Node ingestion path still re-fabricated zeros**, so nothing above would have applied to newly arriving alerts:

- `kafkaConsumer.ts` mapped `ra`, `dec`, `errorRadius`, `snr`, `far` through `_safeFloat(v, fallback = 0)`. The normalizer emits `null` for unreported measurements; this converted them straight back to `0`.
- Combined with the migration-0012 CHECK constraints, that was worse than fabrication: a notice missing any of `snr`/`far`/`error_radius` would **fail the insert and be dropped entirely**. Live ingestion would have started silently losing events.
- `signalness` was absent from both the insert mapping and the upsert SET clause, so it could never be stored.
- `sunDistance`/`moonDistance` were missing from the upsert SET clause, so a revision could not correct or clear stale derived geometry.
- `bootstrap.ts` had the same `safeFloat(...)` zero-coercion on all five source fields.

Added `_measured()` / `_positiveMeasured()` to `kafkaConsumer.ts` mirroring the Python helpers, fixed the bootstrap mapping, and added `signalness`/`sunDistance`/`moonDistance` to the upsert.

**Proof (transactional, rolled back):** a realistic CHIME notice omitting `far` and `loc_error` was pushed through `normalize()` and inserted.
- new behaviour -> `ACCEPTED`, stored `snr 16.98, far NULL, error_radius NULL, sun_distance 77.8499`
- old behaviour (zeros) -> `REJECTED: violates check constraint "chk_error_radius_positive"`

Also note `tsc --build` was required after the schema change — `esbuild` does not type-check, so stale `lib/db` declarations hid the missing `signalness` column type until a real typecheck was run.

### Known remaining
- `latency_us` is still `NOT NULL` and the archive importer writes `NULL_LATENCY = 0`, so archive events display "Latency 0 µs". Same class of defect, not yet migrated.
- Provenance is populated for derived sky geometry only; the ingestion path does not yet write provenance rows for new events.
- No per-event validators for GRB/GW/FRB/NU, no uncertainty propagation, no observability/airmass, no quality score (spec sections 9-36).
- `eventIngestion.ts` still contains `randomBetween(30,150)` for sun/moon (documented dead stub).
- The 279 archive events remain scientifically empty — GCN circulars are free text; recovering their measurements would need a text-extraction pass.

---

## 2026-08-14 — Scientific Integrity Phase 1: sky-geometry provenance

### Critical fix — Sun/Moon separations were wrong by up to ~150°
- `backend/app/gcn/normalizer.py` — `_sun_moon_distance()` took `.separation()` between a barycentric **ICRS** event coordinate and the **GCRS** (geocentric, finite-distance) body position returned by `get_body()`. Astropy reconciles the two origins, which for a ~1 AU body swings the apparent direction wildly. Anchor case (RA 237.42°, Dec −28.74°, 2026-06-09T08:23:11Z) returned **12.77°** where the true separation is **161.36°**. Fixed by transforming the event into `GCRS(obstime=t)` before separating.
- The `NonRotationTransformationWarning` filter at the top of the module was suppressing astropy's warning about exactly this. Removed, with a comment explaining why it must not be reinstated.

### Fabricated values eliminated
- `_sun_moon_distance()` returned `90.0, 90.0` on missing timestamp / ephemeris failure — indistinguishable from a genuine ~90° separation once stored. Now returns `None` (UNKNOWN).
- `_ra_dec_to_gal()` was a hand-rolled IAU 1958 approximation (self-documented ~0.01°, divide-by-zero at b = ±90°). Replaced with astropy ICRS→Galactic; returns `None` when not derivable.
- `artifacts/api-server/src/lib/kafkaConsumer.ts` — `_safeFloat(..., 90)` re-fabricated the same placeholder in the Node ingestion path, which would have silently undone the normalizer fix. Now passes `null` through.
- `artifacts/api-server/src/lib/bootstrap.ts` — same `?? 90` fallback removed.
- Added `_valid_radec()` guard (finite + physical range) shared by both calculations.

### Schema — UNKNOWN is now representable
- `lib/db/migrations/0010_nullable_derived_coords.sql` — dropped NOT NULL on `gal_lat`, `gal_lon`, `sun_distance`, `moon_distance` with column COMMENTs recording DERIVED provenance. These are derived, not measured; NOT NULL structurally forced the pipeline to fabricate. Applied to the live database.
- `lib/db/src/schema/events.ts` updated to match.

### Backfill
- `backend/scripts/backfill_derived_sky_geometry.py` (dry-run by default, `--apply` to commit) — recomputed all 304 rows from their own `ra`/`dec`/`detection_time`. All 304 changed. Post-state: 0 rows at the fabricated `90.0`, 0 outside `[0,180]`, 0 invalid galactic coords, range 0.22°–161.36°.
- Note: psycopg2 returns tz-aware timestamps in the session timezone (+05:30 here); these are converted to UTC explicitly before reaching astropy, otherwise every ephemeris is evaluated at the wrong instant.

### API / frontend propagation
- `lib/api-spec/openapi.yaml` — the 4 fields are now `nullable: true` (kept in `required`: the key is always present, the value may be null) with DERIVED provenance in the descriptions.
- Regenerated-equivalent updates to `lib/api-zod` (`.nullable()`) and `lib/api-client-react` (`number | null`).
- `formatters.ts` — added `formatDerived(value, digits, unit)` rendering `—` for UNKNOWN. Applied across `event-detail.tsx`, `dashboard.tsx`, `BasicInfo.tsx`, `AladinMetadataPanel.tsx` (previously unguarded `.toFixed()` would have thrown on null).
- `useAstroWebSocket.ts` event type updated to `number | null`.

### Tests
- `backend/tests/test_sky_geometry.py` — 28 tests, all passing. Pins the anchor case, cross-checks it against an independent spherical law-of-cosines calculation, explicitly asserts the wrong 12.77° value cannot return, and verifies UNKNOWN is never fabricated.

### Known remaining (not addressed in this phase)
- `_safe_float(val, default=0.0)` in the normalizer still coerces missing **source** measurements (snr, errorRadius) to `0.0`. Source-field nullability is a separate migration.
- `artifacts/api-server/src/lib/eventIngestion.ts` generates **random** sun/moon distances (`randomBetween(30,150)`). It is a documented no-op stub, but the code is still present.
- No provenance table yet: provenance currently lives in schema comments and OpenAPI descriptions, not per-value rows.

---

## 2026-08-14 — Fix: Bookmarks not persisting + Event Archive not scrolling

### Fixed
- `lib/db/migrations/0002_event_bookmarks.sql` — Applied directly to the database. The `tenant.event_bookmarks` table did not exist at all (migration file existed in the repo but was never run against this DB), so every bookmark create/list/delete request was failing server-side. The event-detail page's optimistic UI update flipped the "Bookmarked" button regardless of request success, masking the failure.
- `artifacts/astro-sentinel/src/pages/event-detail.tsx` — `toggleBookmark()` now only flips local state when the fetch response is `ok`, so a failed bookmark request no longer lies to the user.
- `artifacts/astro-sentinel/src/pages/events.tsx` — Added `min-h-0` to the scrollable event grid container. Without it, the `flex-1 overflow-y-auto` div defaulted to `min-height: auto` and grew to fit all content instead of scrolling, so content past the first screenful was clipped by the ancestor `overflow-hidden` chain instead of being reachable via scroll.

---

## 2026-08-13 — Fix: Research Team invitations always failed with "Network error"

### Fixed
- `artifacts/api-server/src/routes/team.ts` — `GET/POST/DELETE /team/invitations` were never implemented server-side even though the frontend (`team.tsx`) called them. Requests 404'd with Express's default HTML error page, and the frontend's `res.json()` threw parsing it, surfacing as a generic "Network error". Added all three routes backed by the existing `labInvitations` table (already used by the registration accept-invite flow), including sending an actual invite email via the existing `EmailProvider` abstraction.

---

## 2026-08-09 — Fix: Docker build failure — missing `eventCorrelations` export

### Fixed
- `lib/db/src/schema/index.ts` — The Core schema re-export block imported `eventCorrelations` (and its `EventCorrelation`/`InsertEventCorrelation` types) from `./events.js` but never re-exported them from the `@workspace/db` barrel. `artifacts/api-server/src/science/correlationEngine/repository.ts` imports `eventCorrelations` from `@workspace/db`, so the API server's esbuild bundle failed with "No matching export in ../../lib/db/src/index.ts for import eventCorrelations", breaking `docker compose up --build`.

### Verified
- `pnpm --filter @workspace/api-server run build` succeeds.

---

## 2026-08-06 — Phase 5.6: AI Scientific Summary Generation

### Added
- `core.ai_scientific_summaries` table in `lib/db/src/schema/events.ts` and `0008_ai_scientific_summaries.sql` migration — caches AI generation outputs by a deterministic hash of the inputs.
- `src/science/summaryEngine/prompts.ts` — Prompts imposing a strict 200-word limit and forcing JSON schema output with 5 fields (significance, origin, followUp, characteristics, confidence).
- `src/science/summaryEngine/index.ts` — Engine that wraps the LLM call. Incorporates a fast 15-second timeout (via `GEMINI_TIMEOUT_MS`) to ensure the pipeline is never permanently blocked.

### Modified
- `src/notifications/notificationService.ts` — Invokes `generateSummary()` and passes `aiSummary` to the template input.
- `src/notifications/notificationTemplates.ts` & `eventTemplate.ts` — Added `aiSummary` to inputs. Renders the AI summary gracefully.
- `src/notifications/templates/components.ts` — Added `aiSummarySection()` to format the JSON data as nicely formatted paragraphs with an indigo border.

### Architecture Notes
- The email notification is sent even if AI generation fails, ensuring no high-priority alert is delayed by AI unreliability.
- Caching is performed by hashing the payload directly (`crypto.createHash('sha256')`), guaranteeing identical inputs aren't sent to the AI API twice.
- JSON output is validated at runtime before cache insertion to prevent bad structure from propagating.

---

## 2026-08-06 — Phase 5.5: Intelligent Notification Deduplication Engine

### Added
- `alerts.notification_history` table in `lib/db/src/schema/alerts.ts` — Append-only audit table storing every deduplication decision. Indexed by `(event_id, sent_at DESC)` for O(1) last-send lookup, and BRIN index on `sent_at` for range queries
- `src/notifications/deduplicationEngine/policy.ts` — Reads `DEDUP_SCORE_DELTA`, `DEDUP_LOCALIZATION_PCT`, `DEDUP_SEND_ON_CONFIRMED`
- `src/notifications/deduplicationEngine/changeDetector.ts` — Pure functions evaluating cross-revision state upgrades (priority increase, correlation upgrade, localization tightening)
- `src/notifications/deduplicationEngine/engine.ts` — `decide()` orchestrator. Suppresses noisy PRELIMINARY/INITIAL/UPDATE traffic unless a meaningful state jump occurs. Always sends on retraction. Emits formatted reasons for audit logs

### Modified
- `src/notifications/notificationService.ts` — Wired `decide()` as Step 5b, directly after Correlation. Calls `recordDecision()` on both send (after enqueue) and suppress (early return)
- `lib/db/src/schema/index.ts` — Exported `notificationHistory` and its types
- `lib/db/migrations/0007_notification_history.sql` — Raw SQL migration for the new table, complete with comments and BRIN index definition
- `.env.example` — Added 3 `DEDUP_*` configuration variables

### Architecture notes
- Complete audit trail: The engine explicitly records *suppressed* revisions alongside *sent* revisions. We can always query exactly why an update was swallowed.
- Total isolation: The change detector is pure math/logic; `engine.ts` handles the orchestration, `store.ts` handles DB I/O. Non-throwing DB operations ensure email dispatch is never blocked by audit log failure.

---

## 2026-08-06 — Phase 5.4: Multi-Messenger Correlation Engine

### Added
- `src/science/correlationEngine/types.ts` — All type definitions (CorrelationInput, CorrelationResult, CorrelationMatch, CorrelationEvent, CorrelationConfidence) matching `docs/correlation.txt` I/O schema exactly
- `src/science/correlationEngine/windows.ts` — Configurable temporal/spatial coincidence windows with scientific justification for every threshold (GW170817/GRB 170817A: ΔT = +1.74 s cited for GW+GRB 5 s window)
- `src/science/correlationEngine/pairingRules.ts` — 6 physically motivated event type pairings with scientific basis strings. Score: GW+GRB=40, GW+NU=30, GRB+NU=25, GW+FRB=20, GRB+FRB=10, NU+FRB=8
- `src/science/correlationEngine/scorer.ts` — Pure `scorePair()`: haversine angular separation, temporal score (linear falloff 35→0 at window edge), spatial score (25→0 at N-sigma threshold), pairing score. Returns full CorrelationMatch with reasoning string
- `src/science/correlationEngine/engine.ts` — Orchestrator: scores all candidates, filters temporally, picks best, maps score to HIGH/MEDIUM/LOW/NONE, generates scientific_assessment + followup_recommendation + reasoning narratives per event type pair
- `src/science/correlationEngine/index.ts` — Public re-exports only

### Modified
- `notifications/notificationService.ts` — Added `fetchCandidateEvents()` (non-throwing DB select within lookback window), added `correlate()` call (step 5a), passes `correlationResult` into `buildEmailContent()`
- `notifications/notificationTemplates.ts` — `correlationResult: CorrelationResult` added to `TemplateInput`. Fully rewritten to clean state
- `notifications/templates/eventTemplate.ts` — Added `CorrelationResult` import and field to `EventTemplateInput`. Added `correlationSection()` component (colour-coded by confidence level). Replaced static correlation placeholder with live data. Follow-up recommendation uses real result when confidence ≠ NONE. Plain-text builder updated in parallel
- `.env.example` — 11 new `CORR_*` vars: temporal windows (6), spatial factor (1), score boundaries (3), DB lookback (1)

### Architecture notes
- `correlationEngine/` is completely isolated from `notifications/` — no cross-dependency
- External scores hook: `CorrelationInput.correlation_scores` blends in pre-computed scores for future AI integration
- `fetchCandidateEvents()` is non-throwing — correlation failure never blocks email dispatch
- `correlationSection()` renders colour-coded card: green=HIGH, amber=MEDIUM, blue=LOW, grey=NONE
- Zero new TypeScript errors introduced

---

## 2026-08-06 — Phase 5.3: Scientific Email Template System

### Added
- `src/notifications/templates/styles.ts` — Priority colour tokens (4 levels), event type metadata, font stacks, `buildStyleBlock()` (dark mode @media, mobile @media, @media print)
- `src/notifications/templates/formatters.ts` — Pure scientific formatters: HMS/DMS sky coords, FAR as human recurrence rate, error radius with unit conversion, T90, fluence, DM, SNR, lifecycle labels
- `src/notifications/templates/components.ts` — 12 reusable HTML component functions: headerBlock, revisionBanner, priorityBadge, sectionHeading, dataRow, dataTable, placeholderSection, spacer, hrule, footerBlock
- `src/notifications/templates/eventTemplate.ts` — Main assembler: 7 named sections, MSO conditionals, full dark mode + responsive + print support, HTML + plain-text output

### Modified
- `notifications/notificationTemplates.ts` — Replaced with thin adapter (57 lines); all HTML delegated to templates/
- `notifications/notificationService.ts` — buildEmailContent now receives Phase 5.2 classification result (priorityLevel, score, reasons, recommendation) and t90

### Architecture notes
- Table-based layout for Outlook compatibility (MSO conditionals in outer wrapper)
- Inline styles on every element (Outlook Word engine)
- class= attributes on key elements for `<style>` block dark mode / responsive overrides
- `color-scheme` meta tag for iOS/macOS native dark mode signalling
- All 7 email sections assembled from component functions — zero duplicated HTML
- 3 placeholder sections (Scientific Summary, Multi-Messenger Correlation, Follow-up) ready for Phase 5.x population
- Zero new TypeScript errors introduced

---

## 2026-08-06 — Phase 5.2: Scientific Priority Classification Engine

### Added
- `src/science/priorityEngine/types.ts` — PriorityLevel (P0-P3), ScoringFactor, ClassificationResult, EventClassificationInput
- `src/science/priorityEngine/thresholds.ts` — All numeric thresholds configurable via env vars; getThresholds() factory
- `src/science/priorityEngine/scoringRules.ts` — 11 independent pure rule functions (retraction, historical, event type, lifecycle, observatory, tier, SNR, localization, revision, FAR, GRB properties)
- `src/science/priorityEngine/classifier.ts` — Aggregator: retraction veto, score sum [0-100], P0/P1/P2/P3 mapping, reasons[], recommendation string
- `src/science/priorityEngine/index.ts` — Public re-exports; all rules individually exported for unit testing

### Modified
- `notifications/priorityEngine.ts` — Replaced with thin compatibility shim (NotificationPriority type + P0→CRITICAL mapper)
- `notifications/notificationService.ts` — Now calls classify() from science engine; P0/P1 → email, P2/P3 → skip; full classification result logged
- `.env.example` — 12 new PRIORITY_* threshold env vars added
- `docs/CURRENT_STATE.md` — Phase 5.2 documented

### Notes
- Zero notification code inside the science engine — complete isolation maintained
- Retraction short-circuits to P3 regardless of other factor scores (−100 veto)
- AI scoring hook: classifier.ts accepts optional aiFactors[] parameter — 10th rule can be added without touching existing code
- All 11 rules exported individually for future unit testing without the full classifier
- Pre-existing TypeScript errors in bookmarks.ts, discussions.ts, notes.ts remain unaffected

---

## 2026-08-06 — Phase 5.1: Email Notification Infrastructure

### Added
- `src/notifications/notificationService.ts` — Orchestrator. Single public function `dispatchForEvent()`.
- `src/notifications/priorityEngine.ts` — Pure priority mapper: CRITICAL/HIGH/MEDIUM/LOW by event type.
- `src/notifications/notificationQueue.ts` — In-process FIFO queue, 3-attempt retry, exponential backoff.
- `src/notifications/emailService.ts` — Provider abstraction: SMTP (nodemailer), Resend, SendGrid, NoOp.
- `src/notifications/notificationTemplates.ts` — HTML + plain-text email templates per GW/GRB/FRB/NU type.
- `src/notifications/notificationLogger.ts` — Structured JSON-lines audit log to `logs/notifications.jsonl`.

### Improved
- `kafkaConsumer.ts` — Single integration point added (1 import + 1 fire-and-forget call).
- `.env.example` — Full notification configuration block added.

### Modified Files
- `artifacts/api-server/src/lib/kafkaConsumer.ts`
- `.env.example`
- `docs/CURRENT_STATE.md`

### Notes
- `EMAIL_PROVIDER=none` (default) keeps system silent — no emails without explicit configuration.
- Priority: CRITICAL → GW new + IceCube GOLD; HIGH → FRB, Swift/EP GRB; MEDIUM → others; LOW → historical.
- Permanent provider errors (4xx) are not retried. Transient errors retry with 2s→4s→8s backoff.
- Pre-existing TypeScript errors in `bookmarks.ts`, `discussions.ts`, `notes.ts` remain unrelated.
- Phase 5.2 will wire `alerts.alert_subscriptions` for per-user preferences.

---

## 2026-08-06

### Added
- Workspace agent rules (`.agents/AGENTS.md`) — docs-first context loading policy
- `docs/PROJECT_CONTEXT.md` — project overview, stack, structure, key entry points
- `docs/CURRENT_STATE.md` — feature status, known bugs, recent changes, priorities
- `docs/ARCHITECTURE.md` — data flow, service communication, Docker stack, auth flow
- `docs/DATABASE.md` — full schema reference, indexes, migration system
- `docs/API_REFERENCE.md` — REST + WebSocket API reference
- `docs/CHANGELOG_AI.md` — this file

### Improved
- Docker setup consolidated: 3 compose files → 1 (`docker-compose.yml`)
- All Dockerfiles moved to repository root (`Dockerfile.api`, `.frontend`, `.python`, `.migrate`)
- `.dockerignore` consolidated from 3 sub-ignores into single root file
- `Dockerfile.python` adapted to use root build context (COPY backend/...)
- `README.md` rewritten with single-command workflow
- `DOCKER.md` updated to remove all `-f docker-compose.*.yml` references

### Fixed
- GitHub push protection violation: `.env` file containing real Gemini API key was committed in refactoring commit. Fixed by `git rm --cached .env` + `git commit --amend`.

### Removed
- `docker-compose.prod.yml` — merged into `docker-compose.yml`
- `docker-compose.dev.yml` — dev workflow documented in README
- `docker/migrate.Dockerfile` — moved to root as `Dockerfile.migrate`
- `docker/` directory
- `artifacts/api-server/Dockerfile` — moved to root
- `artifacts/api-server/.dockerignore` — merged into root
- `artifacts/astro-sentinel/Dockerfile` — moved to root
- `artifacts/astro-sentinel/.dockerignore` — merged into root
- `backend/Dockerfile` — moved to root
- `backend/.dockerignore` — merged into root

### Modified Files
- `docker-compose.yml` (rewritten)
- `.dockerignore` (rewritten/consolidated)
- `.env` (untracked from git; GCN credentials added)
- `.env.example` (GCN_CLIENT_ID, GCN_CLIENT_SECRET added)
- `README.md` (rewritten)
- `DOCKER.md` (rewritten)

### Notes
- The Python Dockerfile was the only one requiring a build context change (was `context: ./backend`, now `context: .` with adjusted COPY paths)
- GCN credentials (`GCN_CLIENT_ID`, `GCN_CLIENT_SECRET`) consolidated from `backend/.env` into root `.env` — single env file for all services
- `backend/.env` retained for local (non-Docker) Python development
-   * * 2 0 2 6 - 0 8 - 0 6 * * :   I n t e g r a t e d   P h a s e   5 . 6   C o r r e l a t i o n - A w a r e   S c i e n t i f i c   N o t i f i c a t i o n s .   U p d a t e d   e v e n t T e m p l a t e . t s   t o   i n c l u d e   c a n d i d a t e   e v e n t s   a n d   d y n a m i c a l l y   h i d e   t h e   c o r r e l a t i o n   s e c t i o n   w h e n   c o n f i d e n c e   i s   N O N E ,   a d h e r i n g   t o   s c i e n t i f i c   r e p o r t i n g   r e q u i r e m e n t s .  
 

## 2026-08-16 — Phase 5: Uncertainty, Units, Cosmology and Derived Science

Spec sections 19-24, 33-34. Turns observations into derived quantities that
carry their own method, assumptions and error bars — and records, explicitly,
everything that could NOT be derived.

### Added
- `backend/app/science/units.py` — canonical unit system across 10 dimensions.
  A unit is never guessed: an absent, unrecognised, or case-ambiguous unit
  returns None, and a cross-dimension conversion (erg -> deg) is refused
  outright because it means two quantities were crossed upstream.
- `backend/app/science/uncertainty.py` — first-order error propagation with the
  independence assumption stated on every result, plus localization containment
  semantics. Encodes that a 90% containment radius is 2.146 sigma in 2-D but
  1.645 sigma in 1-D, and that "68% containment" of a skymap is 1.515 sigma,
  NOT 1 sigma. Sky areas use the spherical cap A = 2*pi*(1 - cos r); the flat
  approximation understates a 20000 deg^2 region's radius by 10%.
- `backend/app/science/cosmology.py` — explicit, named, stamped cosmology
  (Planck18 default; Planck15/WMAP9 selectable via ASTROSENTINEL_COSMOLOGY).
  An unrecognised model derives nothing rather than falling back to a default.
- `backend/app/science/observability.py` — altitude/azimuth/airmass for a
  CONFIGURED site only. With no site these are UNKNOWN with the reason; a
  half-configured site is a configuration error, never completed with zeros.
  Airmass uses Kasten & Young (1989) and is undefined below the horizon rather
  than "very large".
- `backend/app/science/derivations.py` — the derived block persisted per event:
  rest-frame T90/Epeak, luminosity distance, lookback time, band-limited E_iso,
  credible-region geometry, observability.
- `lib/db/migrations/0014_derived_science.sql` — error_radius_containment,
  area_50_deg2, area_90_deg2, luminosity_distance_error, redshift_error,
  derived JSONB, with six CHECK constraints and two partial indexes.
- `artifacts/astro-sentinel/src/components/DerivedSciencePanel.tsx` — renders
  each quantity with its method, assumptions and inputs, and renders UNKNOWN in
  words with the reason and the missing input, never as a blank or a dash.
- `backend/tests/test_derived.py` — 90 tests. Numerical expectations come from
  independent physics (Planck18 literature values, textbook containment
  factors, a hand-computed E_iso), not from this implementation's own output.

### Fixed
- **Credible area stored as a localization radius.** `_igwn()` fell back to
  `raw["area_90"]` — a 90% credible AREA in deg^2 — for `errorRadius`, an ANGLE
  in arcmin. A 100 deg^2 skymap was recorded as a 1.67 deg radius when the
  equivalent radius is 5.6 deg: a unit, a dimension and a containment
  convention conflated in one assignment. Areas now have their own columns.
- **The sky viewer asserted a confidence level the data never stated.**
  `FitsLocalizationViewer` labelled every drawn circle "1σ Error Radius". Most
  sources state no convention at all, and mislabelling a 90% region as 1σ
  misrepresents the search area by ~4.6x in solid angle. The label now reports
  what the source said, or says the convention was not stated.
- **Live ingestion could drop alerts on the new constraints.** An out-of-range
  or inverted credible area would have failed the INSERT and silently lost the
  event — the same failure mode found in Phase 2. `_skyArea()` and an inversion
  guard discard the impossible value while the validator's diagnostic preserves
  the record of what the source reported.
- **Whole-sky region returned UNKNOWN.** `area_to_radius_deg` rejected the full
  sky because cos_r evaluated to -1.0000000000000002; a completely unlocalized
  event has a radius of 180 deg, not an undefined one.
- **Frontend types resolved through a stale `dist/`.** `AstroEvent` had been
  missing Phase 3's `validation`/`quality` since they were added, which is why
  they needed `as never` casts. Rebuilt; the casts the spec warns against are
  now gone from the derived path.

### Changed
- `grb.py` now derives band-limited E_iso when a redshift, a cosmology and a
  stated energy band are all present — and still refuses the bolometric E_iso,
  which needs a k-correction from a fitted spectral model no alert carries.
  The two differ by a non-constant factor of ~1.5-5 and are never conflated.
- `gw.py` offers a distance-inverted redshift as an explicitly MODEL-DEPENDENT
  estimate, never written into the `redshift` field.
- `neutrino.to_gev` delegates to the shared unit registry and checks the
  dimension, so an angle labelled onto an energy field cannot convert.
- `frb.py` propagates DM and DM_MW errors into the extragalactic excess.
- `validators.py` gained check_units, check_localization_semantics and
  check_observability. Unstated containment is a NOTICE, not a WARNING: nearly
  every alert omits it, and a warning on every event would train researchers to
  ignore the panel.

### Verification
- 257 backend tests pass (167 -> 257).
- D_L(z=1) = 6797 Mpc and lookback 7.94 Gyr match Planck18 literature; E_iso
  recomputes to 5.7176e50 erg against an independent hand calculation, and its
  error combines correctly (0.0595 fluence (+) 0.0958 from D_L^2 = 0.1127).
- All six CHECK constraints proven to reject bad writes transactionally, with
  the valid case accepted.
- 304 archive events backfilled. Every cosmological and rest-frame quantity is
  UNKNOWN because the archive contains zero redshifts — verified directly
  against the database, not assumed.
- All 7 routes x both Science Mode states load clean; panel content verified
  in-browser (cosmology stamp, UNKNOWN wording, containment warning, expandable
  method/requires).
- Observability verified against real geometry from Paranal: airmass 2.468 at
  23.78 deg altitude vs sec(z) = 2.480, correctly lower.

### Known limitations
- The archive has no redshifts, so no cosmological quantity is currently
  derivable for any stored event. This is reported, not hidden.
- Observability is off until ASTROSENTINEL_SITE_LAT/LON are set.
- `latency_us` remains NOT NULL with a 0 placeholder in the archive importer
  (pre-existing; outside this phase).


## 2026-08-16 — Phase 6: Revision Intelligence and Scientific Delta Detection

Spec sections 27-28. Revisions previously overwrote the event in place; this
phase makes what changed visible, and judges whether the change makes
scientific sense.

### The problem
`core.events` was updated by an UPSERT that replaced the row and incremented a
counter. The previous scientific state was destroyed. If a localization moved
40 degrees between the preliminary and updated notice, nothing recorded that it
had moved — the event simply *was* wherever the latest notice put it, and a
researcher who had already pointed a telescope at the first position had no way
to find out.

### Added
- `backend/app/science/revisions.py` — the delta engine. Its central judgement
  is refinement vs inconsistency: a position that moves *within* the combined
  uncertainties is routine, while one that moves far outside them means the
  notices disagree. Reporting both as "position updated" hid a real failure
  behind a routine label, so the second is an ERROR at 3 sigma.
  Comparisons are refused where they would be meaningless: localization radii
  are only compared when both notices state the SAME containment convention,
  because a source switching 1-sigma -> 90% would otherwise show a 2.15x
  "degradation" that is purely an artefact of the convention (spec 23).
- `lib/db/migrations/0015_event_revisions.sql` — append-only
  `core.event_revisions`: one row per notice, with the snapshot and the delta
  against its predecessor. Unique on (event_pk, revision_index) so reprocessing
  a notice cannot duplicate history; CHECK that the first notice carries no
  delta; ON DELETE CASCADE.
- `POST /api/science/revision-delta` on the Python backend, and
  `artifacts/api-server/src/lib/revisionRecorder.ts`. The api-server owns the
  database and therefore knows the previous state, but the delta RULES stay in
  Python and exist exactly once — a second TypeScript implementation is how the
  correlation scorer drifted in Phase 2.
- `GET /events/:id/revisions` and
  `artifacts/astro-sentinel/src/components/RevisionTimeline.tsx`. Shown outside
  Science Mode too: a retraction or an inconsistent position is not a
  specialist detail.
- `backend/tests/test_revisions.py` — 39 tests.

### Fixed
- **A lost localization counted as a perfect one.** `changeDetector.ts` read
  `if (currentRadius <= 0) return true; // Perfect localization`. Since Phase 2
  an absent localization is null and arrives there as 0, so a revision that
  STOPPED reporting a localization fired a "LOCALIZATION_IMPROVED" alert.
  Losing the uncertainty is a loss of knowledge, not a refinement, and no real
  instrument reports a zero-radius position.

### Design decisions worth recording
- A delta that could not be computed stores `significance = null` and is
  rendered as "changes unknown", never as "no changes". A revision whose
  comparison never ran must not read as an uneventful one.
- Every notice is recorded, including the first: a history that begins at the
  second notice cannot show what the first one said.
- Recording history can never drop an alert. Every failure path degrades to an
  unknown delta with the reason attached.

### Verification
- 296 backend tests pass (257 -> 296).
- Haversine geometry hand-checked: 1 deg of RA at dec = 60 is 0.5 deg on the
  sky; RA wraparound 359.5 -> 0.5 is 1 deg, not 359.
- Exercised end-to-end through the real production code path (not a
  re-implementation): three notices produced rev 0 = no delta, rev 1 = ROUTINE
  (0.4 sigma refinement + 66.7% tighter localization), rev 2 = CRITICAL
  (position inconsistent at 169.8 sigma + FAR worsened 1000x). The material
  revision emitted a WARN log. Cascade delete verified; the archive returned to
  exactly 304 events.
- All 7 routes x both Science Mode states clean; the timeline verified
  in-browser with critical and routine revisions visually distinct.

### Known limitations
- The 304 archive events predate revision tracking and have no history. The UI
  says so explicitly rather than implying they were never revised.


## 2026-08-16 — Phase 7: Research Interest and AI Guardrails

Spec sections 40-44. The final phase of the Scientific Event Intelligence and
Validation Layer.

### The defect this phase found
The AI summary path built the model's context like this:

    snr:         Number(event["snr"]         ?? 0),
    far:         Number(event["far"]         ?? 0),
    ra:          Number(event["ra"]          ?? 0),
    dec:         Number(event["dec"]         ?? 0),
    errorRadius: Number(event["errorRadius"] ?? 0),

while the prompt beside it insisted: "NO HALLUCINATION — you MUST NOT invent
physics that are not explicitly present in the provided metadata."

The metadata was doing the inventing. 279 of 304 archive events have no
reported position and would have been described to the model as sitting at
RA = 0, Dec = 0; 294 have no false-alarm rate and would have been presented as
FAR = 0 Hz — which does not mean "unknown", it means *no false alarms ever*,
i.e. infinite significance. A model obeying its instructions perfectly would
still have written that these events were extraordinarily significant and
precisely located. The anti-hallucination guard was defeated by its own input.

### Added
- `backend/app/science/ai_context.py` — `build_context()` passes only measured
  values, each with unit and provenance, and lists every unknown explicitly
  with its reason. Derived quantities are kept in a separate block with their
  assumptions so a modelled distance can never be presented as an observation.
  The rules travel inside the context itself, so they survive prompt edits.
- `verify_output()` — screens generated text for numeric claims not traceable
  to the supplied context. Honest about its limits: it catches numbers that
  were never supplied and cannot catch a wrong interpretation built from
  correct ones, so a finding means "a human should look", not "this is false".
  Ignores small integers and years so prose does not bury real findings.
- `artifacts/api-server/src/science/aiGuard.ts` + three Python endpoints
  (`/api/science/ai-context`, `/verify-ai-output`, `/interest`). When the
  context cannot be built the summary is SKIPPED, not generated from the old
  fabricating shape — the email already falls back to raw data, which is
  honest. A summary quoting unsupported values is withheld.
- `backend/app/science/interest.py` — research interest score (spec 44), the
  THIRD score in the pipeline and deliberately distinct from the other two:

      quality_score    Is the DATA trustworthy?        (Phase 3)
      priority P0-P3   Should someone be emailed NOW?  (notification engine)
      interest_score   Is this worth STUDYING?         (this phase)

  They diverge by design. A flawlessly-measured routine GRB scores 100 quality
  / 35 interest; a nearby BNS merger with a 15000 deg^2 skymap scores 90
  quality / 80 interest. One number could not express both.
- `lib/db/migrations/0016_research_interest.sql`,
  `ResearchInterestPanel.tsx`, and `backend/tests/test_interest_and_ai.py`
  (35 tests).

### Fixed
- The AI context fabrication described above.
- **An unassessed event ranked as an uninteresting one.** Five OTHER-type
  optical transients scored 0 and read as MINIMAL. "We looked and found little"
  and "we had nothing to look at" are different statements, so a run in which
  no rule contributes now returns band UNASSESSED with the reason. Found by
  inspecting the backfill distribution, not by a test.

### Honesty constraints in the interest score
- An UNKNOWN never adds interest. A missing FAR contributes nothing rather
  than the maximum — the same trap as the AI context, since FAR = 0 would mean
  infinite significance.
- A missing localization is not a perfect one (the Phase 6 inversion).
- A retraction zeroes the score.
- Every point is traceable to a named rule with its rationale, so a researcher
  can disagree with a specific rule rather than an opaque total.
- The score is labelled a triage heuristic for ordering a queue, never a
  measured property of the event.

### Audit result (no defect)
The existing notification priority engine was checked for the same
UNKNOWN-inflation bug and is clean: every rule guards absent values with
`noContribution()`.

### Verification
- 331 backend tests pass (296 -> 331).
- Confirmed against the live endpoint that an unlocalized archive event's
  context contains no `"ra": 0` and no `"far": 0`, and that the output screen
  flags a fabricated position and FAR.
- Archive backfilled: interest bands LOW 296 / MODERATE 3 / UNASSESSED 5,
  ordering GW > NU > FRB > GRB as expected.
- Real archive event S260605a serves quality 95 alongside interest 48 — the
  two scores visibly answering different questions.
- All 7 routes x both Science Mode states clean; panel verified in-browser
  including the per-rule rationales, the "not assessed" note and the
  triage-heuristic disclaimer.

### Known limitations
- The interest rules are judgements, not measurements. They are stated
  explicitly and individually so they can be argued with; they are not
  presented as objective.
- The output screen is numeric only. It cannot detect a false claim built from
  correct numbers.

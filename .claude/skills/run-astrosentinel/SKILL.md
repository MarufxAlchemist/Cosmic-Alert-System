---
name: run-astrosentinel
description: Build, launch, drive and screenshot the Transient Event Detection dashboard — the Python GCN Kafka backend, the Node api-server, and the Vite frontend together. Use when asked to run, start, boot, smoke-test, screenshot, or manually verify the app or the dashboard, or to hit its API as a signed-in user.
---

# Run Transient Event Detection

All paths are relative to the **repo root**.

Transient Event Detection is **three co-dependent processes**. None is useful alone:

| Service | Dir | Port | Role |
|---|---|---|---|
| Python GCN backend | `backend/` | 8001 | `gcn-kafka` consumer; broadcasts on `/api/ws` |
| api-server | `artifacts/api-server/` | 8000 | Express + WS; connects to 8001 **as a client**; owns Postgres |
| frontend | `artifacts/astro-sentinel/` | 5173 | React SPA; Vite proxies `/api` → 8000 (`ws:true`) |

They must start **in that order** — the api-server dials `ws://localhost:8001/api/ws` on boot.

**The UI is auth-gated and you cannot register.** Every route bounces to a login form, and
`POST /auth/register` returns `403 Registration requires an invitation` once any user exists.
The driver mints a JWT with the repo's own `JWT_SECRET` and seeds it into `localStorage`.
Do not try to script the login form — this is the working path.

Everything below was run on **Windows 11 + Git Bash**, Node 22.14, pnpm 11.5.2, Python 3.12.5.

---

## Prerequisites

PostgreSQL must be running and `DATABASE_URL` in `.env` must point at a **populated** database
(the driver reads a user out of `identity.users` and picks an event to open). Check:

```bash
node .claude/skills/run-astrosentinel/driver.mjs status
```

One-time install of the driver's browser library — `playwright-core` only, it uses **system
Chrome** rather than downloading a 300 MB browser:

```bash
cd .claude/skills/run-astrosentinel && PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install && cd -
```

This deliberately has its **own** `package.json` outside the pnpm workspace, so the driver never
enters the app's dependency graph or `pnpm-lock.yaml`.

---

## Build

The api-server runs its **built bundle**; `driver.mjs up` refuses to start without it.

```bash
pnpm --filter @workspace/api-server build
```

The frontend is served by Vite in dev — no build step needed to run it.

---

## Run (agent path)

```bash
# start all three, in order, waiting on each health check
node .claude/skills/run-astrosentinel/driver.mjs up

# full UI flow + screenshots, signs itself in
node .claude/skills/run-astrosentinel/driver.mjs smoke

# stop everything
node .claude/skills/run-astrosentinel/driver.mjs down
```

`up` takes ~8 s and prints per-service PIDs and log paths. Verified cold-start output:

```
Starting services (order matters — api-server dials :8001 on boot)…
  python-backend pid 2272 -> .../.logs/python-backend.log
  waiting for python-backend ..ok (3.1s)
  api-server pid 37236 -> .../.logs/api-server.log
  waiting for api-server .ok (1.5s)
  frontend pid 26952 -> .../.logs/frontend.log
  waiting for frontend .ok (1.6s)

All three up.  Dashboard: http://localhost:5173
```

### All commands

| Command | Does |
|---|---|
| `up` | Kills stale listeners, starts all three, waits for health |
| `down` | Stops all three **by listening port** |
| `status` | HTTP status of each service **and** of `/api` through the Vite proxy |
| `smoke` | Dashboard → archive categories → click into a category → event detail → expand a circular; asserts; screenshots; exits non-zero on failure |
| `shot <path> [name]` | Screenshot any route, signed in — `shot /events archive` |
| `api <path>` | Authenticated GET through the Vite proxy — `api /events/stats` |
| `token` | Print a 2 h JWT for use with `curl` |

Screenshots land in `.claude/skills/run-astrosentinel/.shots/`, logs in `.../.logs/`.
Both are gitignored. **Open the screenshot and look at it** — a login form means auth failed.

Verified `smoke` output:

```
[1/5] Mission Control
  PASS  signed in (no login form)
  PASS  live event list rendered
  PASS  every event type appears in the header composition
  PASS  composition reconciles with the total
[2/5] Event Archive — categories
  PASS  category cards rendered
        categories: ["Gamma-ray Bursts","Gravitational Waves","Fast Radio Bursts","Neutrinos","Unclassified Transients"]
  PASS  gamma-ray bursts category present
  PASS  no event type is left ungrouped (would be invisible in the archive)
  PASS  GRB count exceeds one page, so it cannot be a page count
[3/5] Drill into a category
  PASS  URL carries the group, so the view is linkable
  PASS  drill-in states the archive-wide total
  PASS  events listed
[4/5] Event detail
  PASS  Evidence Timeline present
  PASS  GCN Circulars present
  PASS  circular entries rendered
[5/5] Expand a circular
  PASS  original source block
  PASS  original body text loaded
app console errors: 0
SMOKE PASSED
```

`smoke` opens whichever event has the **most attached GCN circulars**, so the circular and
timeline panels have content. On a database with no circulars it still passes the archive steps
and reports the event-detail ones honestly.

Step 1 cross-checks the Mission Control header against `/api/events/stats`: every `event_type`
with a non-zero count must appear in the header, and the type counts must sum to `totalEvents`.
The strip this header replaced hardcoded GRB/GW/FRB, so on a database carrying EP, NU and OTHER
it rendered 239 directly beside "Total: 305" and said nothing about the missing 66.

Step 2 cross-checks the rendered category counts against `/api/events/groups` and asserts
`ungrouped` is empty — an `event_type` in the database belonging to no category would be
invisible in the archive, which is exactly the bug the category redesign fixed.

### Hitting the API by hand

```bash
node .claude/skills/run-astrosentinel/driver.mjs api /events/19212/circulars
TOKEN=$(node .claude/skills/run-astrosentinel/driver.mjs token | sed -n 's/^token: //p')
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:5173/api/auth/me
```

Go through **5173**, not 8000 — that exercises the Vite proxy the browser actually uses.

---

## Run (human path)

Three terminals, in order (this is what `run-commands.txt` documents):

```bash
cd backend && ./venv/Scripts/python.exe -m uvicorn app.main:app --host 0.0.0.0 --port 8001
cd artifacts/api-server && pnpm dev          # needs DATABASE_URL, PORT=8000, JWT_SECRET, PYTHON_BACKEND_URL
cd artifacts/astro-sentinel && pnpm dev
```

Then open http://localhost:5173 and sign in. You need a real password — the driver's minted
token is the only way in without one.

---

## Test

```bash
pnpm --filter @workspace/api-server test     # 215 unit tests, no DB needed
cd backend && python -m pytest tests/ -q     # 388 tests
```

Database-backed checks need a live `DATABASE_URL` and use the workspace `tsx`
(**not** in `artifacts/api-server/node_modules`):

```bash
cd artifacts/api-server
DATABASE_URL='...' ../../scripts/node_modules/.bin/tsx src/scripts/verify_circulars.ts
```

---

## Gotchas

- **`pkill -f` does not stop these processes.** `pkill -f dist/index.mjs` exits 0 and leaves the
  listener holding the port. The next launch then dies with `EADDRINUSE` while the log looks like
  a startup crash. Kill by **listening port** — `driver.mjs down` does this via
  `Get-NetTCPConnection … | Stop-Process`.

- **Never launch a service through `pnpm` on Windows — two traps stack.** `pnpm` is a `.cmd`
  shim; Node ≥20 refuses to spawn a `.cmd` without a shell (`spawn EINVAL`, not `ENOENT`,
  CVE-2024-27980 hardening). Add `shell:true` and the shell then swallows the child's output, so
  `frontend.log` lands **0 bytes** and a Vite startup failure leaves nothing to debug. The driver
  launches every service as a real executable instead — Vite via
  `node artifacts/astro-sentinel/node_modules/vite/bin/vite.js`, which also starts ~1.5 s faster.

- **`require.resolve("vite/bin/vite.js")` throws.** Vite's package `exports` map does not list
  `./bin/vite.js` — you get `ERR_PACKAGE_PATH_NOT_EXPORTED`. Use the filesystem path directly.

- **Git Bash mangles leading-slash arguments.** `driver.mjs api /events/stats` arrives as
  `C:/Program Files/Git/events/stats` and 404s against a nonsense URL. `routeArg()` undoes it;
  `api events/stats` (no leading slash) also works.

- **The auth token must be in `localStorage` *before* first paint.** `AuthContext` reads it
  synchronously on mount, so setting it after `page.goto` just bounces to `/login`. The driver
  uses `context.addInitScript`.

- **`pg` is not resolvable from `artifacts/api-server`.** pnpm links strictly and `pg` belongs to
  `@workspace/db`; requiring it from the api-server root fails `MODULE_NOT_FOUND`. Resolve it
  from `lib/db/package.json`. (`jsonwebtoken` *is* a direct api-server dep and resolves fine.)

- **`GSI_LOGGER` / `403` console errors are permanent noise** — the Google Sign-In widget failing
  because `GOOGLE_CLIENT_ID` is a placeholder. The driver filters them so a real error is visible.

- **`networkidle` fires before the panels paint.** Circulars, timeline and revision panels
  self-fetch after mount. The driver waits an extra 2 s; a screenshot taken at `networkidle`
  catches empty cards.

- **Vite uses `strictPort: true`.** A stale listener on 5173 is fatal rather than silently moving
  to 5174 and breaking the `/api` proxy target.

- **Two Pythons, neither complete.** `backend/venv` has `fastapi` + `gcn_kafka` but **no
  `pytest`**; the system Python has `pytest` but no `fastapi`. Tests run on the **system** Python
  and stub the missing modules; the **venv** runs the server.

- **The Python backend reads `backend/.env`** (for `GCN_CLIENT_ID`/`SECRET`), not the root `.env`.
  It must be started with `cwd=backend/`.

- **Archive counts come from the server, never from the page.** `/api/events/groups` returns
  archive-wide counts and each group's `event_type` composition; `/api/events?group=GRB` filters
  by the same taxonomy (`lib/eventGroups.ts`). Grouping client-side over the current page is what
  the redesign removed — it produced "8 on this page", which is not a category count.

- **`eventType` alone cannot express this archive.** The generated enum is `[GRB, GW, FRB]`, so
  `EP`, `NU` and `OTHER` — 66 of 305 events here — are unreachable through it. Use `group=`.

- **The `Gamma-ray Bursts` category spans two `event_type` labels.** The same Einstein Probe
  mission is stored as `GRB` when a notice arrives live and `EP` when it came from the circular
  archive import. The group covers both; the UI states this on the card and in the drill-in.

- **`sql`​`${table.column}` renders UNQUALIFIED inside a Drizzle template.** In a correlated
  subquery Postgres then resolves it against the INNER table: `c.event_pk = ${eventsTable.id}`
  became `c.event_pk = c.id`, and every count came back 0 with no error. Write the outer column
  out in full — `"core"."events"."id"`.

- **The services are detached; nothing supervises them.** They survive across shell invocations,
  but an external process-tree teardown can take them down with no error in the logs (observed
  once). `status` is the check and `up` is idempotent — if something looks broken, run `status`
  before debugging the app.

- **No live GCN alerts is normal.** The consumer uses `auto.offset.reset=latest`, so a quiet
  broker means an empty live feed. Existing events come from the database.

---

## Troubleshooting

| Symptom | Cause → fix |
|---|---|
| `Error: listen EADDRINUSE :::8000` | A stale listener `pkill` didn't kill. `driver.mjs down`, then `up`. |
| `spawn EINVAL` | Something is spawning a `.cmd` (pnpm) without a shell. Launch the executable directly — see Gotchas. |
| A service log is 0 bytes but the service is up | Its output went through a shell wrapper. Launch the executable directly. |
| A service was up and is now down, logs end cleanly | External process-tree teardown. Re-run `up`; it is idempotent. |
| `Cannot find module 'pg'` | Resolved from the wrong package root. Use `lib/db/package.json`. |
| `dist/index.mjs missing` | `pnpm --filter @workspace/api-server build` |
| Screenshot shows "Researcher Access Portal" | Token not seeded before paint, or `JWT_SECRET` in `.env` ≠ the one the server booted with. Restart with `up`, which passes `.env` through. |
| `No user in identity.users with a tenant.lab_members row` | Empty database. Seed one, or set `ASTRO_TEST_USER_ID` + `ASTRO_TEST_USER_EMAIL`. |
| `playwright-core is not installed` | `cd .claude/skills/run-astrosentinel && npm install` |
| `No Chrome/Edge found` | Set `CHROME_PATH` to a browser executable. |
| api-server up but `[kafka-bridge] WebSocket error` | Python backend isn't on 8001. Check `.logs/python-backend.log`. Reconnect backs off to 60 s, so restart via `up` rather than waiting. |
| `driver.mjs api` 404s on a real route | Git Bash path mangling — drop the leading slash. |

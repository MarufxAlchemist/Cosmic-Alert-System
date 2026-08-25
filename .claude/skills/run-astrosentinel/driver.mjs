#!/usr/bin/env node
/**
 * driver.mjs — launch and drive the Transient Event Detection dashboard.
 *
 * Transient Event Detection is three co-dependent processes. None of them is useful alone:
 *
 *   backend/            uvicorn :8001   GCN Kafka consumer, broadcasts on /api/ws
 *   artifacts/api-server  node :8000    Express + WS; connects to :8001 as a CLIENT
 *   artifacts/astro-sentinel  vite :5173  React SPA; proxies /api -> :8000 (ws:true)
 *
 * Two things make driving this app non-obvious, and both are handled here:
 *
 *  1. THE UI IS AUTH-GATED. Every route redirects to a login form. Registration
 *     is closed (`POST /auth/register` returns 403 "Registration requires an
 *     invitation" once any user exists), so you cannot sign up a test account.
 *     `token` mints a JWT with the repo's own JWT_SECRET for a user that is
 *     already in identity.users, and the browser commands seed it into
 *     localStorage before first paint.
 *
 *  2. pkill DOES NOT STOP THESE PROCESSES on Windows. `pkill -f dist/index.mjs`
 *     exits 0 and leaves the listener holding the port, so the next launch dies
 *     with EADDRINUSE and the log looks like a crash. `down` kills by LISTENING
 *     PORT via PowerShell, which is the only thing that reliably works.
 *
 * Usage (from the repo root):
 *
 *   node .claude/skills/run-astrosentinel/driver.mjs up      # start all three
 *   node .claude/skills/run-astrosentinel/driver.mjs status  # health of each
 *   node .claude/skills/run-astrosentinel/driver.mjs smoke   # drive UI + screenshots
 *   node .claude/skills/run-astrosentinel/driver.mjs shot /events archive
 *   node .claude/skills/run-astrosentinel/driver.mjs api /events/stats
 *   node .claude/skills/run-astrosentinel/driver.mjs token
 *   node .claude/skills/run-astrosentinel/driver.mjs down
 */

import { spawn, execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, openSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SKILL_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(SKILL_DIR, "..", "..", "..");
const LOGS = path.join(SKILL_DIR, ".logs");
const SHOTS = path.join(SKILL_DIR, ".shots");

const PY_PORT = 8001;
const API_PORT = 8000;
const WEB_PORT = 5173;
/**
 * Where the browser and `api` commands point.
 *
 * Overridable because `localhost` is not always this machine's dev server. VS
 * Code Remote-SSH forwards a remote port by binding 127.0.0.1, and a bind to
 * 127.0.0.1 WINS over the dev server's 0.0.0.0 — so with a remote session open,
 * every request here silently reaches the REMOTE deployment instead. It looks
 * like the local app with someone else's database: signed-out, wrong event
 * counts, "User no longer exists".
 *
 * Set ASTRO_BASE_URL to this host's LAN address (or an IPv6 loopback, if the
 * server binds ::) to be sure of which deployment you are driving.
 */
const BASE = process.env.ASTRO_BASE_URL?.replace(/\/+$/, "") ?? `http://localhost:${WEB_PORT}`;

for (const d of [LOGS, SHOTS]) if (!existsSync(d)) mkdirSync(d, { recursive: true });

// ─── env ─────────────────────────────────────────────────────────────────────

/** Parse a .env file. Values may contain '='; only the first one splits. */
function readEnv(file) {
  const out = {};
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i === -1) continue;
    out[t.slice(0, i)] = t.slice(i + 1).replace(/^["']|["']$/g, "");
  }
  return out;
}

const ENV = readEnv(path.join(REPO, ".env"));

function requireEnv(key) {
  const v = ENV[key];
  if (!v) {
    console.error(`Missing ${key} in ${path.join(REPO, ".env")}. Copy .env.example and fill it in.`);
    process.exit(1);
  }
  return v;
}

// ─── process control ─────────────────────────────────────────────────────────

/**
 * Kill whatever is LISTENING on a port.
 *
 * Not `pkill -f`: on Windows that matches nothing for these processes, exits 0,
 * and leaves the port held — the next `up` then dies with EADDRINUSE while the
 * log makes it look like the app crashed on startup.
 */
function killPort(port) {
  try {
    const out = execSync(
      `powershell -NoProfile -Command "(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue).OwningProcess"`,
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    const pids = [...new Set(out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean))];
    for (const pid of pids) {
      execSync(`powershell -NoProfile -Command "Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue"`, {
        stdio: "ignore",
      });
      console.log(`  stopped PID ${pid} (port ${port})`);
    }
    return pids.length;
  } catch {
    return 0;
  }
}

/**
 * Launch a plain executable, streaming stdout+stderr into `.logs/<name>.log`.
 *
 * Every service is launched this way — as a real .exe, never through a package
 * manager. Going via `pnpm dev` on Windows means a `.cmd` shim, which Node >=20
 * refuses to spawn without a shell (`spawn EINVAL`, CVE-2024-27980 hardening),
 * and the shell then swallows the output so the log lands 0 bytes. Both traps
 * disappear by pointing at the executable itself.
 */
function launch(name, command, args, cwd, env) {
  const log = path.join(LOGS, `${name}.log`);
  const fd = openSync(log, "w");
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...env },
    detached: true,
    stdio: ["ignore", fd, fd],
    shell: false,
    windowsHide: true,
  });
  child.unref();
  console.log(`  ${name} pid ${child.pid} -> ${log}`);
}

async function waitFor(label, url, timeoutMs = 90_000) {
  const start = Date.now();
  process.stdout.write(`  waiting for ${label} `);
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(4000) });
      if (r.ok) {
        console.log(`ok (${((Date.now() - start) / 1000).toFixed(1)}s)`);
        return true;
      }
    } catch {
      /* not up yet */
    }
    process.stdout.write(".");
    await new Promise((r) => setTimeout(r, 1500));
  }
  console.log(" TIMEOUT");
  console.error(`  see ${path.join(LOGS, `${label}.log`)}`);
  return false;
}

// ─── auth ────────────────────────────────────────────────────────────────────

/**
 * Mint a session JWT for a user that already exists in identity.users.
 *
 * The UI cannot be reached any other way: `/auth/register` is invitation-only
 * once a user exists, and the token in run-commands.txt expired in 2026-06.
 * Signed with the repo's own JWT_SECRET, so the api-server accepts it — the
 * same secret it verifies with. Short TTL because it is a debugging credential.
 */
async function mintToken() {
  const secret = requireEnv("JWT_SECRET");

  // jsonwebtoken is a dependency of the api-server, so it is already installed
  // in the workspace store — no extra install for the common case.
  const { createRequire } = await import("node:module");
  const req = createRequire(path.join(REPO, "artifacts", "api-server", "package.json"));
  const jwt = req("jsonwebtoken");

  const user = await resolveUser();
  const token = jwt.sign({ userId: user.userId, email: user.email, role: user.role }, secret, {
    expiresIn: "2h",
  });
  return { token, user };
}

/**
 * Resolve `pg` from lib/db, not from api-server.
 *
 * pnpm links strictly: `pg` is a dependency of @workspace/db, so it is NOT
 * resolvable from artifacts/api-server even though the server uses it through
 * the db package. Requiring it from the wrong root fails with MODULE_NOT_FOUND.
 */
async function pgClient() {
  const { createRequire } = await import("node:module");
  const req = createRequire(path.join(REPO, "lib", "db", "package.json"));
  return req("pg").Client;
}

/**
 * Pick a user to impersonate.
 *
 * Prefers ASTRO_TEST_USER_ID / ASTRO_TEST_USER_EMAIL from the environment;
 * otherwise reads the first admin out of tenant.lab_members via the api-server's
 * own database connection so the driver does not need psql on PATH.
 */
async function resolveUser() {
  if (process.env.ASTRO_TEST_USER_ID && process.env.ASTRO_TEST_USER_EMAIL) {
    return {
      userId: process.env.ASTRO_TEST_USER_ID,
      email: process.env.ASTRO_TEST_USER_EMAIL,
      name: "Driver",
      role: "admin",
    };
  }

  const client = new (await pgClient())({ connectionString: requireEnv("DATABASE_URL") });
  await client.connect();
  try {
    const { rows } = await client.query(
      `SELECT u.id, u.email, u.name, m.role
         FROM identity.users u
         JOIN tenant.lab_members m ON m.user_id = u.id
        ORDER BY (m.role = 'admin') DESC, u.created_at
        LIMIT 1`,
    );
    if (!rows.length) {
      throw new Error(
        "No user in identity.users with a tenant.lab_members row. " +
          "The UI cannot be entered — seed a user first.",
      );
    }
    const r = rows[0];
    return { userId: r.id, email: r.email, name: r.name ?? "Researcher", role: r.role };
  } finally {
    await client.end();
  }
}

// ─── browser ─────────────────────────────────────────────────────────────────

/** System Chrome. playwright-core is used WITHOUT downloading a browser. */
const CHROME_CANDIDATES = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
];

function findChrome() {
  const hit = CHROME_CANDIDATES.find((p) => existsSync(p));
  if (!hit) {
    console.error("No Chrome/Edge found. Set CHROME_PATH to a browser executable.");
    process.exit(1);
  }
  return process.env.CHROME_PATH ?? hit;
}

async function loadPlaywright() {
  const { createRequire } = await import("node:module");
  const req = createRequire(path.join(SKILL_DIR, "package.json"));
  try {
    return req("playwright-core");
  } catch {
    console.error(
      "playwright-core is not installed.\n" +
        `  cd ${path.relative(process.cwd(), SKILL_DIR) || "."} && npm install`,
    );
    process.exit(1);
  }
}

/** A browser context with the session already in localStorage. */
async function authedContext() {
  const { chromium } = await loadPlaywright();
  const { token, user } = await mintToken();

  const browser = await chromium.launch({ executablePath: findChrome(), headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1200 } });

  // Seeded via addInitScript so it is present BEFORE the app's first render —
  // AuthContext reads localStorage synchronously on mount, so setting it after
  // navigation just bounces you to /login.
  await ctx.addInitScript(
    ([t, u]) => {
      localStorage.setItem("astrosentinel_token", t);
      localStorage.setItem("astrosentinel_user", u);
    },
    [token, JSON.stringify({ userId: user.userId, email: user.email, name: user.name, role: user.role })],
  );

  const page = await ctx.newPage();
  const errors = [];
  page.on("console", (m) => {
    const t = m.text();
    // GSI_LOGGER / 403 are the Google Sign-In widget failing because
    // GOOGLE_CLIENT_ID is a placeholder. Always present, never a real fault.
    if (m.type() === "error" && !t.includes("GSI_LOGGER") && !t.includes("Failed to load resource")) {
      errors.push(t);
    }
  });
  page.on("pageerror", (e) => errors.push(`PAGEERROR: ${e.message}`));
  return { browser, page, errors, token };
}

async function goto(page, url, waitFor) {
  await page.goto(url, { waitUntil: "networkidle", timeout: 60_000 });
  if (waitFor) {
    try {
      await page.waitForSelector(waitFor, { timeout: 25_000 });
    } catch {
      console.log(`  !! selector never appeared: ${waitFor}`);
    }
  }
  // The panels self-fetch after mount; networkidle fires before they paint.
  await page.waitForTimeout(2000);
}

// ─── argument handling ───────────────────────────────────────────────────────

/**
 * Normalise a route argument.
 *
 * Git Bash (MSYS) rewrites any argument that looks like an absolute POSIX path
 * before the program ever sees it: `driver.mjs api /events/stats` arrives as
 * `C:/Program Files/Git/events/stats`. The request then 404s against a URL that
 * makes no sense, which reads like a broken route rather than a mangled
 * argument. Undo it here so both `/events/stats` and `events/stats` work from
 * any shell.
 */
function routeArg(raw, fallback = "/") {
  if (!raw) return fallback;
  let p = String(raw).split("\\").join("/");
  const mangled = p.match(/^[A-Za-z]:\/.*?\/Git\/(.*)$/);
  if (mangled) p = `/${mangled[1]}`;
  if (!p.startsWith("/")) p = `/${p}`;
  return p;
}

// ─── commands ────────────────────────────────────────────────────────────────

async function cmdUp() {
  console.log("Stopping anything already on the ports…");
  for (const p of [WEB_PORT, API_PORT, PY_PORT]) killPort(p);

  const dbUrl = requireEnv("DATABASE_URL");

  console.log("\nStarting services (order matters — api-server dials :8001 on boot)…");

  // 1. Python GCN backend. Reads backend/.env for GCN_CLIENT_ID/SECRET, so cwd
  //    must be backend/.
  launch(
    "python-backend",
    path.join(REPO, "backend", "venv", "Scripts", "python.exe"),
    ["-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", String(PY_PORT)],
    path.join(REPO, "backend"),
    {},
  );
  if (!(await waitFor("python-backend", `http://localhost:${PY_PORT}/health`))) process.exit(1);

  // 2. api-server. Runs the BUILT bundle: `pnpm dev` rebuilds then starts, which
  //    is slower and harder to health-check. Build separately (see SKILL.md).
  const dist = path.join(REPO, "artifacts", "api-server", "dist", "index.mjs");
  if (!existsSync(dist)) {
    console.error(`\n  ${dist} missing — run: pnpm --filter @workspace/api-server build`);
    process.exit(1);
  }
  launch("api-server", process.execPath, ["--enable-source-maps", dist], path.join(REPO, "artifacts", "api-server"), {
    ...ENV,
    DATABASE_URL: dbUrl,
    PORT: String(API_PORT),
    PYTHON_BACKEND_URL: `ws://localhost:${PY_PORT}/api/ws`,
    NODE_ENV: "development",
  });
  if (!(await waitFor("api-server", `http://localhost:${API_PORT}/api/healthz`))) process.exit(1);

  // 3. Vite. strictPort:true, so a stale listener is fatal rather than silently
  //    moving to 5174 and breaking the /api proxy target.
  //    Vite is launched as a plain node process on its own entry file rather
  //    than through `pnpm dev`. Going through pnpm means a `.cmd` shim, which
  //    needs a shell, and BOTH layers eat the output: frontend.log came out 0
  //    bytes every time, so a Vite startup failure left nothing to debug with.
  //    Running the entry directly gives real logs and drops the shell entirely.
  //    (The path is used verbatim — vite's package `exports` map does not list
  //    ./bin/vite.js, so require.resolve on it throws ERR_PACKAGE_PATH_NOT_EXPORTED.)
  const web = path.join(REPO, "artifacts", "astro-sentinel");
  const viteBin = path.join(web, "node_modules", "vite", "bin", "vite.js");
  if (!existsSync(viteBin)) {
    console.error(`\n  ${viteBin} missing — run: pnpm install`);
    process.exit(1);
  }
  // Same arguments as the package's own `dev` script.
  launch("frontend", process.execPath, [viteBin, "--config", "vite.config.ts", "--host", "0.0.0.0"], web, {});
  if (!(await waitFor("frontend", `${BASE}/`))) process.exit(1);

  console.log(`\nAll three up.  Dashboard: ${BASE}`);
  console.log(`Logs: ${LOGS}`);
  console.log("The UI is auth-gated — use `smoke` / `shot`, which sign in for you.");
}

function cmdDown() {
  console.log("Stopping services…");
  let n = 0;
  for (const p of [WEB_PORT, API_PORT, PY_PORT]) n += killPort(p);
  console.log(n ? "Stopped." : "Nothing was listening.");
}

async function cmdStatus() {
  const checks = [
    ["python-backend", `http://localhost:${PY_PORT}/health`],
    ["api-server", `http://localhost:${API_PORT}/api/healthz`],
    ["frontend", `${BASE}/`],
    ["api via vite proxy", `${BASE}/api/healthz`],
  ];
  for (const [name, url] of checks) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
      console.log(`  ${name.padEnd(20)} HTTP ${r.status}`);
    } catch (e) {
      console.log(`  ${name.padEnd(20)} DOWN (${e.message})`);
    }
  }
}

async function cmdToken() {
  const { token, user } = await mintToken();
  console.log(`user : ${user.email} (${user.role})`);
  console.log(`token: ${token}`);
  console.log(`\ncurl -s -H "Authorization: Bearer $TOKEN" ${BASE}/api/auth/me`);
}

/** Authenticated API call through the Vite proxy — the path the browser uses. */
async function cmdApi(rawPath) {
  if (!rawPath) {
    console.error("usage: driver.mjs api /events/stats");
    process.exit(1);
  }
  const { token } = await mintToken();
  const url = `${BASE}/api${routeArg(rawPath)}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const body = await r.text();
  console.log(`HTTP ${r.status}  ${url}`);
  try {
    console.log(JSON.stringify(JSON.parse(body), null, 2).slice(0, 4000));
  } catch {
    console.log(body.slice(0, 2000));
  }
}

/** Screenshot any route, signed in. */
async function cmdShot(rawPath = "/", name = "shot") {
  const { browser, page, errors } = await authedContext();
  const url = `${BASE}${routeArg(rawPath)}`;
  console.log(`-> ${url}`);
  await goto(page, url);
  const file = path.join(SHOTS, `${name}.png`);
  await page.screenshot({ path: file });
  console.log(`   ${file}`);
  if (errors.length) console.log(`   console errors: ${errors.length}`);
  await browser.close();
}

/**
 * The full flow: dashboard -> archive -> event detail -> expand a circular.
 *
 * Asserts on things that are actually load-bearing, so a blank page fails
 * loudly instead of producing a clean-looking screenshot of nothing.
 */
async function cmdSmoke() {
  const { browser, page, errors } = await authedContext();
  let failures = 0;
  const ok = (label, cond, detail = "") => {
    console.log(`  ${cond ? "PASS" : "FAIL"}  ${label}${cond || !detail ? "" : ` — ${detail}`}`);
    if (!cond) failures++;
  };

  // 1. Dashboard
  console.log("\n[1/5] Mission Control");
  await goto(page, `${BASE}/`, "text=Mission Control");
  await page.screenshot({ path: path.join(SHOTS, "01-dashboard.png") });
  ok("signed in (no login form)", (await page.locator("text=Researcher Access Portal").count()) === 0);
  ok("live event list rendered", (await page.locator("text=LIVE EVENTS").count()) > 0);

  // The header composition must account for EVERY event_type, and the chips
  // must reconcile with the total shown beside them. The strip this replaced
  // hardcoded GRB/GW/FRB, so on this database it displayed 239 next to a
  // "Total: 305" and said nothing about the missing 66.
  const statsApi = await page.evaluate(() => fetch("/api/events/stats").then((r) => r.json()));
  const headerText = await page.locator("header").first().innerText();
  const missing = Object.entries(statsApi.byType)
    .filter(([, n]) => Number(n) > 0)
    .map(([t]) => t)
    .filter((t) => !new RegExp(`\\b${t}\\b`).test(headerText));
  ok(
    "every event type appears in the header composition",
    missing.length === 0,
    `absent: ${JSON.stringify(missing)}`,
  );
  const chipSum = Object.values(statsApi.byType).reduce((n, c) => n + Number(c), 0);
  ok(
    "composition reconciles with the total",
    chipSum === Number(statsApi.totalEvents),
    `types sum to ${chipSum}, total is ${statsApi.totalEvents} — the residual segment covers this, but it should be visible`,
  );

  // 2. Archive landing — one card per messenger category, archive-wide counts.
  console.log("\n[2/5] Event Archive — categories");
  await goto(page, `${BASE}/events`, "text=Event Archive");
  await page.screenshot({ path: path.join(SHOTS, "02-archive-categories.png") });

  const cards = page.locator("button", { has: page.locator("h2") });
  ok("category cards rendered", (await cards.count()) > 0, `count=${await cards.count()}`);
  const labels = await cards.locator("h2").allTextContents();
  console.log(`        categories: ${JSON.stringify(labels)}`);
  ok("gamma-ray bursts category present", labels.some((l) => /gamma/i.test(l)));

  // The card counts must be ARCHIVE-WIDE, not page-sized — that was the whole
  // point of the redesign — so cross-check against the API rather than
  // trusting the rendered number alone.
  const groupsApi = await page.evaluate(() => fetch("/api/events/groups").then((r) => r.json()));
  ok(
    "no event type is left ungrouped (would be invisible in the archive)",
    groupsApi.ungrouped.length === 0,
    JSON.stringify(groupsApi.ungrouped),
  );
  const grb = groupsApi.groups.find((g) => g.key === "GRB");
  ok("GRB count exceeds one page, so it cannot be a page count", (grb?.count ?? 0) > 24, `count=${grb?.count}`);

  // 3. Drill in by CLICKING the card — the interaction a scientist performs,
  //    not a direct navigation to the URL.
  console.log("\n[3/5] Drill into a category");
  await cards.filter({ hasText: /Gamma-ray Bursts/ }).first().click();
  await page.waitForTimeout(2500);
  ok("URL carries the group, so the view is linkable", page.url().includes("group=GRB"), page.url());
  await page.screenshot({ path: path.join(SHOTS, "03-archive-drilldown.png") });

  const header = await page
    .locator("text=/events in this archive/")
    .first()
    .innerText()
    .catch(() => "");
  ok("drill-in states the archive-wide total", header.includes(String(grb?.count ?? "")), header);
  ok("events listed", (await page.locator("a[href^='/events/']").count()) > 0);

  // 4. Event detail — the event with the most circulars, so the panels have
  //    something to show.
  console.log("\n[4/5] Event detail");
  const eventPk = await richestEventPk();
  await goto(page, `${BASE}/events/${eventPk}`, "text=GCN Circulars");
  await page.screenshot({ path: path.join(SHOTS, "04-event-detail.png") });
  ok("Evidence Timeline present", (await page.locator("text=Evidence Timeline").count()) > 0);
  ok("GCN Circulars present", (await page.locator("text=GCN Circulars").count()) > 0);
  const entries = await page.locator("text=/GCN Circular #\\d+/").count();
  ok("circular entries rendered", entries > 0, `count=${entries}`);

  // 4. Expand a circular — the original source text is lazy-loaded per circular.
  console.log("\n[5/5] Expand a circular");
  const first = page.locator("button", { hasText: /GCN Circular #/ }).first();
  if (await first.count()) {
    await first.scrollIntoViewIfNeeded();
    await first.click();
    await page.waitForTimeout(3000);
    ok("original source block", (await page.locator("text=Original circular — source of record").count()) > 0);
    const body = await page.locator("pre").first().innerText().catch(() => "");
    ok("original body text loaded", body.length > 50, `${body.length} chars`);
    await first.scrollIntoViewIfNeeded();
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(SHOTS, "05-circular-expanded.png") });
  } else {
    ok("a circular was expandable", false, "no circular entries on this event");
  }

  console.log(`\napp console errors: ${errors.length}`);
  for (const e of errors.slice(0, 8)) console.log(`  ${e}`);
  console.log(`screenshots: ${SHOTS}`);

  await browser.close();
  console.log(failures === 0 ? "\nSMOKE PASSED" : `\nSMOKE FAILED (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

/** core.events.id of the event with the most attached circulars. */
async function richestEventPk() {
  const client = new (await pgClient())({ connectionString: requireEnv("DATABASE_URL") });
  await client.connect();
  try {
    const { rows } = await client.query(
      `SELECT e.id, count(c.id) AS n
         FROM core.events e
         LEFT JOIN core.event_circulars c ON c.event_pk = e.id
        GROUP BY e.id ORDER BY n DESC, e.detection_time DESC LIMIT 1`,
    );
    return rows[0]?.id ?? 1;
  } finally {
    await client.end();
  }
}

// ─── main ────────────────────────────────────────────────────────────────────

const [cmd, ...rest] = process.argv.slice(2);
const commands = {
  up: cmdUp,
  down: () => cmdDown(),
  status: cmdStatus,
  token: cmdToken,
  api: () => cmdApi(rest[0]),
  shot: () => cmdShot(rest[0] ?? "/", rest[1] ?? "shot"),
  smoke: cmdSmoke,
};

if (!cmd || !commands[cmd]) {
  console.log("usage: node driver.mjs <up|down|status|smoke|shot <path> [name]|api <path>|token>");
  process.exit(cmd ? 1 : 0);
}

await commands[cmd]();

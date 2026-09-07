# Astro-COLIBRI Lightcurve Export (Priority #6) — BLOCKED UPSTREAM

Status as of **2026-09-07**: not implemented, and not implementable today. The
blocker is on Astro-COLIBRI's side, not in this repository. No code was written
for Priority #6; this document exists so the next person does not re-derive any
of it.

The API facts in section 3 remain true regardless of the outage and were each
verified against the live service, because the published documentation was
wrong about every one of them.

---

## 1. What is blocked, and what is not

**Blocked:** CSV / VOTable export of survey lightcurves, which depends on
`GET /lightcurve`.

**Not blocked, already shipped, unaffected:**

| Feature | Endpoint | Auth |
|---|---|---|
| Afterglow context figure (Lightcurves tab) | `/optical_afterglow_lightcurve` | none — public |
| Follow-up reports tab | `/followup_summary` | none — public |

Both were confirmed to work with an **invalid** `uid`, so they are genuinely
unauthenticated and nothing about this outage touches them.

---

## 2. The failure: tasks are accepted, then reaped

`GET /lightcurve` accepts requests normally — HTTP 200, a valid
`lightcurve_id`, the standard "the lightcurve is being generated" message —
and the task then ceases to exist before ever reaching a terminal state.

**Five attempts, five reaps, zero successes. `csv_url` and `votable_url` were
never observed in any response.**

| # | Event | Surveys requested | Furthest progress | Outcome |
|---|---|---|---|---|
| 1 | GRB 210822A (trigger 1069788) | default (all) | `0.8 — "Completed atlas"` | reaped |
| 2 | GRB 210822A | default (all) | `0.8 — "Completed atlas"` | reaped |
| 3 | GRB 210822A | `ztf` only (ignored — see §3.5) | `0.5 — "Completed asas-sn"` | reaped |
| 4 | GRB 221009A (trigger 1126853) | default (all) | none — gone within 30 s | reaped |
| 5 | GRB 230307A (trigger 00021537) | **`rapas` only** | none — gone within 30 s | reaped |

Terminal state in every case:

```json
{"status": "unknown", "progress": 0, "message": "No such task_id"}
```

### Why this is an upstream problem, not ours

Each variable that could have made it event-specific was changed, and none
mattered:

* **Event.** GRB 221009A is the brightest GRB ever recorded and the most
  heavily-followed burst in the archive. If any trigger has rich archival
  optical photometry across every survey, it is that one. Same failure.
* **Survey provider.** Attempt 5 requested **only RAPAS**, with ZTF, LSST,
  ATLAS, ASAS-SN and AAVSO all disabled — none of the providers the earlier
  attempts stalled on. Same failure.
* **Trigger-id format.** `1069788`, `1126853` and the zero-padded `00021537`
  all behaved identically, so it is not an id-parsing quirk.

Attempts 4 and 5 died *faster and earlier* than attempts 1–3 (no progress at
all, versus reaching 0.5–0.8), which if anything suggests the upstream worker
was degrading over the course of the session rather than being stably broken.

---

## 3. Verified API corrections

Every item below contradicts either the published documentation at
`astro-colibri.science/apidoc` or the original Priority #6 handoff note. Each
was measured against the live service. **Trust this section over the docs.**

### 3.1 Auth is a `uid` query parameter, not an API key

The handoff said "requires a free account for export endpoints, API key stored
server-side". There is no API key and no header auth. It is an
Astro-COLIBRI **user id** passed as a query parameter:

```
GET /lightcurve?uid=<28-char Firebase-style uid>&trigger_id=1126853
```

Evidence:

```
/lightcurve?trigger_id=1069788                       → 400 (missing uid)
/lightcurve?trigger_id=1069788&uid=INVALID_UID_PROBE → {"message": "User does not exist", "status_code": "403"}
```

Obtain it by registering free at astro-colibri.science, then
**Menu → Account → Account details**. Registration is self-service, no
approval. The docs link a tutorial: `https://youtu.be/MJLTeNXp8Xw`

**Only `/lightcurve` requires it.** The two public endpoints above do not.

### 3.2 There is no CSV or VOTable endpoint

`csv_url` and `votable_url` are **fields of `/lightcurve`'s eventual success
response**, not endpoints of their own. There is nothing to call directly.

Because no task has ever completed, **those two field names come solely from
the documentation and have never been observed in a real response.** Do not
write a parser against them until one has been seen — the docs have been wrong
about the base URL, three parameter names, a response field name, the transport
and the status endpoint's URL form.

### 3.3 `text/event-stream` is misdeclared; the first chunk is plain JSON

`/lightcurve` responds with `Content-Type: text/event-stream; charset=utf-8`
and `Transfer-Encoding: chunked`, but the payload is **not** SSE-framed. Raw
first bytes:

```
7b 22 6c 69 67 68 74 63 75 72 76 65 5f 69 64 22 ...
 {  "  l  i  g  h  t  c  u  r  v  e  _  i  d  "
```

No `data:` prefix, no `\n\n` terminator — a bare JSON object:

```json
{"lightcurve_id": "6252a873", "status": "200",
 "message": "the lightcurve is being generated and to see the progress please go here: https://astro-colibri.science/lightcurve_status/6252a873."}
```

It emits that **one** chunk and then holds the connection open indefinitely —
verified by holding it for **260 seconds** with nothing further received. So:

* `await res.json()` will **hang**. Read the first chunk and parse it, then
  abandon the stream.
* The result never arrives on this connection. `/lightcurve_status` is the only
  route to it.

`/lightcurve_status/<id>` is *also* a stream, re-emitting the same progress
object repeatedly in one response body. Read one chunk, parse the first JSON
object, close.

### 3.4 `/lightcurve_status` takes a path segment, not a query parameter

```
/lightcurve_status?lightcurve_id=abcd1234  → 404
/lightcurve_status/abcd1234                → 200 {"status": "...", "progress": 0.0, "message": "..."}
```

### 3.5 Survey-filter parameters appear to be ignored

Attempt 3 passed `ztf=true&atlas=false&asas-sn=false` and the worker still ran
ASAS-SN (`"Completed asas-sn"`). Do not build a survey-picker UI on
`ztf`/`lsst`/`atlas`/`asas-sn`/`aavso`/`rapas` without first confirming they
take effect.

### 3.6 `/lightcurve` keys on `trigger_id`, not `?name=`

Unlike `/optical_afterglow_lightcurve` and `/followup_summary`, which accept
`?name=GRB210822A`, this endpoint needs the numeric trigger id. Resolve it
first via the public `/event?source_name=<name>`, which returns `trigger_id`:

```
/event?source_name=GRB221009A  →  trigger_id "1126853"
/event?source_name=GRB230307A  →  trigger_id "00021537"
/event?source_name=GRB210822A  →  trigger_id "1069788"
```

Note `/event` requires **`source_name`** and rejects `name` with a 400 — the
opposite convention to the other two endpoints. The parameter name is not
consistent across this API.

---

## 4. Retest recipe (one call, ~2 minutes)

Costs 5 units. Run it before doing anything else on this feature:

```bash
# 1. Start a generation (uid from the environment; never hard-code it)
curl -sN "https://astro-colibri.science/lightcurve?uid=$ASTRO_COLIBRI_UID&trigger_id=1126853"
#    → read the FIRST chunk only, take lightcurve_id, then close the connection

# 2. Poll twice
curl -s "https://astro-colibri.science/lightcurve_status/<id>"   # at +30s
curl -s "https://astro-colibri.science/lightcurve_status/<id>"   # at +2min
```

**If the task survives past 30 seconds, that alone is new information** and the
outage may have cleared — every attempt on 2026-09-07 was gone by then or
stalled without ever finishing.

If it reaches a terminal state, **capture the full response verbatim**. That
payload is the real specification for `csv_url` / `votable_url`, and is worth
more than anything in the published docs.

---

## 5. Design decisions that stand regardless

These were settled during the Priority #6 investigation and do not need
revisiting when the outage clears.

**The `uid` lives server-side, but is not a rotatable secret.** It goes in the
api-server environment as `ASTRO_COLIBRI_UID` and never reaches the browser.
But it is a Firebase-style account identifier, not a credential like
`GEMINI_API_KEY`: it cannot be rotated without creating a new account. Do not
model it as a secret that can be revoked under incident response.

**No byte proxy — a plain link is enough.** Astro-COLIBRI's returned storage
URLs are **public-read Google Cloud Storage objects, not pre-signed**. Verified
by fetching one with no auth of any kind: HTTP 200, `image/png`, 89,534 bytes,
valid PNG magic bytes, and no `X-Goog-Signature` or `Expires` in the URL. So
the browser can fetch them directly:

```tsx
<a href={csvUrl} download>…</a>
```

Proxying the bytes through the api-server would add load and a streaming code
path while buying nothing. (Corollary worth knowing: anything Astro-COLIBRI
generates is world-readable to anyone holding the URL.)

**A bounded polling deadline is mandatory.** Tasks get reaped, so an unbounded
poller would spin forever against `"No such task_id"`. The client must give up
after a fixed deadline and return `{ available: false }` — matching the
`null`-vs-`{available:false}` contract that `fetchAfterglow` and
`fetchFollowupSummary` already use in
`artifacts/api-server/src/services/astro-colibri/client.ts`:

* `null` — we could not reach Astro-COLIBRI; we know nothing.
* `{ available: false }` — they answered and hold nothing.

Reporting an outage as an absence of observations is the failure mode that
contract exists to prevent.

**The rate-limit budget is shared, and small.** `/lightcurve` costs **5 units**
against the **same** 100-units-per-24h account budget as `/followup_summary` —
not a separate pool. That is ~20 lightcurve requests per day for the whole
deployment, since the uid is per-account and not per-viewer. Caching is
therefore more important here than it was for the follow-up tab: reuse the
6-hour TTL shape of `followupCache` in `client.ts`, as its own separate cache
instance, caching only `available: true` results.

**Route shape, when it is built:** `GET /events/:id/colibri/export`, following
`routes/colibri.ts` — `400` bad id, `404` no such event, `501` when
`ASTRO_COLIBRI_UID` is unset (distinct from `502`: "not configured" and "they
are down" are different problems, mirroring how `routes/events.ts` separates a
missing `GEMINI_API_KEY` from a provider error), `502` upstream unreachable,
`200` with `{ available, csvUrl, votableUrl, plotUrl }`.

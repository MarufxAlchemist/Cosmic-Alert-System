# WeChat Notifications (WeCom Group Robot)

Delivers Transient Event Detection alerts to WeChat via an official WeCom (企业微信) group
robot webhook.

---

## What this is, and what it is not

**There is no "log in with WeChat and receive alerts" flow, and there cannot
be.** This is the single most important thing to understand before configuring
the channel, because the mental model determines whether the setup makes sense.

| Mechanism | What it actually does | Usable for alerts? |
|---|---|---|
| **WeCom group robot webhook** | Outbound only. Someone in the org creates a robot inside a WeCom group and receives a URL. No end user logs in, ever. | **Yes — this is what we use** |
| WeChat OAuth ("login with WeChat") | Authenticates a person. Confers **no** right to message them. Requires a verified business entity. | No |
| WeChat Official Account (公众号) template messages | Can reach personal WeChat, but requires business verification, pre-approved templates, and the recipient must already follow the account. | Not implemented |
| Personal-account automation (QR login, protocol reimplementation, client automation) | Impersonates a real user session. Violates Tencent's terms; accounts get banned. | **Never** |

Recipients read the messages in WeCom, or in ordinary WeChat through the
WeCom↔WeChat bridge.

### QQ

Not available. Tencent provides no official API for messaging a **personal** QQ
account from a third-party service. The supported route is a QQ group or
channel bot registered on the QQ Open Platform, which requires developer
registration and review. The UI states this rather than showing a "Coming Soon"
badge on something that cannot deliver.

---

## Manual setup in WeCom (required — cannot be automated)

1. Open the **WeCom desktop or mobile app** and go to the group that should
   receive alerts.
2. Group settings → **群机器人 / Group Robot** → **添加机器人 / Add Robot**.
3. Name it (e.g. `Transient Event Detection`) and confirm.
4. Copy the **Webhook URL**. It looks like:

   ```
   https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=<KEY>
   ```

5. In Transient Event Detection: **Research Notification Center → Notification Channels →
   WeChat**, paste the URL, **Save webhook**, then **Send test notification**.

> **The webhook URL is a bearer credential.** Anyone holding it can post to
> that group. There is no second factor and no per-message signature. Treat it
> like a password: do not paste it into chat, a ticket, or a commit.

Creating the robot requires a registered WeCom organisation with real-name
verification. That step is unavoidable and cannot be performed on your behalf.

---

## Server configuration

```bash
# Encrypts provider credentials at rest (AES-256-GCM). REQUIRED.
# Without it, the WeChat endpoints return 503 rather than storing a
# secret in plaintext.
NOTIFICATION_ENCRYPTION_KEY=$(openssl rand -hex 32)

# Routes every provider send to an in-process sink. Use for development.
NOTIFICATION_TEST_MODE=false

# Retry tuning (optional).
NOTIFICATION_MAX_ATTEMPTS=5
NOTIFICATION_RETRY_BACKOFF_MS=0,5000,30000,120000,600000
NOTIFICATION_RETRY_JITTER=0.2

# Absolute base URL, used to build the "Open event" link in messages.
PUBLIC_APP_URL=https://astrosentinel.example.org
```

**Rotating `NOTIFICATION_ENCRYPTION_KEY` invalidates every stored credential.**
Decryption fails closed with a clear error and users must re-save their
webhooks. There is no migration path, by design — a key that can decrypt old
values after rotation is not a rotation.

`WECOM_CORP_ID` / `WECOM_AGENT_ID` / `WECOM_SECRET` are **not** used. Those
belong to the WeCom Application Messaging API, a different transport. They are
omitted rather than listed-unused.

The webhook itself is deliberately **not** an environment variable: it is
per-user configuration. A global one would send every lab's alerts to a single
group.

---

## API

All endpoints require `Authorization: Bearer <jwt>`.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/notifications/wechat` | Redacted status + health |
| `PUT` | `/api/notifications/wechat` | Save/replace the webhook |
| `DELETE` | `/api/notifications/wechat` | Remove it |
| `POST` | `/api/notifications/wechat/test` | Send a test message |
| `GET` | `/api/notifications/deliveries` | Recent delivery history |

**No endpoint returns the credential** — not for the owner, not for an admin.
`GET` returns only a redacted display string:

```json
{
  "configured": true,
  "display": "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=••••beef",
  "health": "unknown",
  "healthDetail": "Webhook is configured and well-formed. WeCom provides no non-sending validation endpoint…"
}
```

### Health values

| Value | Meaning |
|---|---|
| `configuration_required` | No webhook saved, or it is invalid |
| `unknown` | Saved and well-formed, but **not proven reachable** |
| `degraded` | Recent deliveries are failing |
| `connected` | A delivery has actually succeeded |

`unknown` is not a bug. WeCom exposes no way to validate a key without sending
a message, and posting to the user's group on every settings-page load would be
spam. A configured webhook is never rendered as "connected" merely because a
URL exists.

---

## Security

- **AES-256-GCM at rest**, authenticated so tampering is detected. Versioned
  ciphertext (`v1:iv:tag:data`) for future rotation.
- **Host pinned to `qyapi.weixin.qq.com`.** Without this, "webhook URL" is an
  SSRF primitive: a user could save `http://169.254.169.254/` or
  `http://postgres:5432` and probe the internal network *through* the
  notification service. Rejected and tested: cleartext HTTP, cloud metadata IP,
  internal Docker hostnames, `localhost`, lookalike domains
  (`qyapi.weixin.qq.com.attacker.cn`), wrong paths, short keys.
  `redirect: "error"` prevents a 3xx walking off the pinned host.
- **Unconditional redaction.** Every provider error passes through
  `redactSecrets()` before being returned or logged. HTTP clients routinely
  embed the request URL in error strings, so a failed POST would otherwise leak
  the key into Pino without anyone logging a URL.
- **Tenant isolation.** The JWT carries no `labId`; the lab is resolved from
  `lab_members` server-side on every request and all queries are scoped by
  `(userId, labId)`. Delivery history joins through the subscription, because
  scoping on `alerts.lab_id` alone would expose colleagues' deliveries.
- **Test endpoint rate limited** to 5/min per user — it posts to a real group.
- **`DELETE` removes the row** rather than deactivating it; an inactive row
  still holding ciphertext retains a credential the user asked us to discard.

---

## Delivery pipeline

```
Kafka → normalize → scientific filter → DATABASE → event accepted
     → priority (P0–P3) → correlation → deduplication
     → dispatcher: subscription match → delivery row → provider → WeCom
```

Delivery never blocks ingestion. Every entry point is non-throwing and
fire-and-forget: a WeCom outage, a revoked webhook or a database error leaves
GCN consumption, persistence and the WebSocket dashboard untouched.

### Filtering

Event type, observatory, priority threshold and lifecycle are each checked
independently, and a filtered event records which rule excluded it.

**A retraction overrides every content filter.** Someone who acted on the
original alert — pointed a telescope, filed a circular — must be told it was
withdrawn, regardless of type, priority or observatory subscription.

`"update": "significant_only"` defers to the deduplication engine, which
already gates the dispatcher. It is not re-decided here.

### Retry

| Failure | Behaviour |
|---|---|
| `configuration` (e.g. errcode 94000, webhook deleted) | **Never retried.** Fails identically every time; retrying only delays telling the user. |
| `invalid_payload` | Never retried. |
| `provider_error`, `network`, `timeout` | Ladder: immediate → 5 s → 30 s → 2 min → 10 min, ±20 % jitter. |
| `rate_limited` (errcode 45009) | Rescheduled **without consuming an attempt.** |

Rate limiting is not a failure. If it spent the attempt budget, one burst of
GCN traffic would exhaust every queued alert's retries and drop them all —
exactly on the busiest night.

Deliveries are **rows in `alerts.alerts`**, not an in-memory queue, so a
restart mid-backoff resumes rather than losing them.

### Duplicate protection

Idempotency key = `eventId | revision | subscriptionId | channel`, enforced by
a **UNIQUE index**. Application-level checks race under concurrent dispatcher
ticks; the database is the only place the guarantee holds. A revision is a
distinct key and does alert.

### Rate limiting

Sliding window, 20/minute per credential — WeCom's documented ceiling. A
sliding window rather than a token bucket because the rule is literally "N in
any 60 seconds"; a bucket permits N at the end of one window and N at the start
of the next, tripping the limit it exists to respect.

> **Scaling note:** the limiter is in-process. Exact for a single api-server
> container. If the API is scaled horizontally it must move to Postgres or
> Redis, or each replica will independently allow 20/min.

---

## Message format

Only fields the pipeline actually measured are rendered. **An UNKNOWN value is
omitted, never printed as `0`, `null` or `N/A`** — the notification is the one
artifact a researcher reads on their phone, and a fabricated zero there undoes
the entire validation layer.

```
## ASTROSENTINEL ALERT
### GRB808341387

**Type:** Gamma-ray burst
**Observatory:** Fermi (GBM)
**Lifecycle:** CONFIRMED
**Detected:** 2026-08-13 19:16:22 UTC
**Position:** RA 231.4200° · Dec -57.7500°
**Localization:** 2.48° (containment not stated by source)
**SNR:** 17.2 σ
**Data status:** WARNING · quality 89/100
```

FAR, T90 and fluence are absent above because that notice does not report them.
The formatter **computes nothing** — it renders the validated event the
scientific pipeline produced.

Content is truncated by **bytes**, not characters: WeCom caps markdown in
bytes and Chinese characters are 3 bytes each in UTF-8, so 4096 characters
could be ~12 KB on the wire. Truncation never splits a codepoint.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `503` on save | `NOTIFICATION_ENCRYPTION_KEY` not set | Set it and restart |
| `400 Webhook host must be qyapi.weixin.qq.com` | Not an official WeCom robot URL | Copy the URL from 群机器人 |
| errcode **94000** | Webhook deleted or disabled in WeCom | Recreate the robot, save the new URL |
| errcode **93000** | Robot not authorised | Check the robot in WeCom |
| errcode **45009** | Rate limit (20/min) | Automatic; deliveries defer, not drop |
| Health stuck at `unknown` | No delivery has succeeded yet | Send a test |
| `429` on test | 5/min per-user cap | Wait |
| History empty | No events have matched the subscription | Not a fault — a test send does not create a delivery row |
| Decryption error after a deploy | `NOTIFICATION_ENCRYPTION_KEY` changed | Re-save the webhook |

---

## Testing

```bash
# Unit — no database, network or broker (103 tests)
pnpm --filter @workspace/api-server test

# Rules of Hooks and lint
pnpm --filter @workspace/astro-sentinel lint

# Database-backed, against a running stack
tsx src/scripts/verify_dispatcher.ts              # queueing, idempotency, retry
tsx src/scripts/verify_wechat_tenant_isolation.ts # cross-lab isolation
tsx src/scripts/demo_wechat_notification.ts       # rendered message walkthrough
```

The database-backed checks are scripts rather than unit tests deliberately: a
UNIQUE index rejecting a duplicate, and `FOR UPDATE SKIP LOCKED` claiming a row
exactly once, are precisely the behaviours a mock would fake.

---

## Known limitations

1. **End-to-end delivery to Tencent is unverified.** Every layer up to the HTTP
   boundary is tested, but no message has reached WeCom's servers — that
   requires a real robot webhook. Until then, treat the channel as unproven in
   production.
2. **No non-sending health check.** WeCom offers no validation endpoint, so
   reachability is only confirmed by an actual delivery.
3. **In-process rate limiter** — see the scaling note above.
4. **Group delivery, not per-person.** A robot posts to the group it was
   created in. Per-recipient routing needs the Application Messaging API.
5. **QQ is not implemented** — see the top of this document.

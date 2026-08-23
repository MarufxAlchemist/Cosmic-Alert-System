# API_REFERENCE.md — Transient Event Detection

> Last updated: 2026-08-06

## Base URL

- **Development:** `http://localhost:8000/api`
- **Docker (internal):** `http://api-server:8000/api`
- **Frontend proxy:** `/api/*` → `api-server:8000` (via nginx)

---

## REST Endpoints

### `GET /api/healthz`
Health check. No auth.
```json
{ "status": "ok" }
```

---

### `GET /api/events`
Paginated event list.  
**Auth:** None (⚠️ should be protected)

**Query params:**

| Param | Type | Default | Notes |
|---|---|---|---|
| `limit` | int | 50 | Max results |
| `offset` | int | 0 | Pagination |
| `eventType` | string | — | GRB / GW / FRB / NU |

**Missing filters:** `observatory`, `lifecycle`, `source`, date range, sort options.

**Response:**
```json
{
  "events": [
    {
      "id": "1",
      "eventId": "GRB20260614T120000Z",
      "eventType": "GRB",
      "observatory": "Swift (BAT)",
      "detectionTime": "2026-06-14T12:00:00.000Z",
      "ra": 123.456, "dec": 45.678,
      "errorRadius": 2.5, "snr": 15.3, "far": 1e-7,
      "fluence": 1.23e-6, "t90": null, "dm": null,
      "chirpMass": null, "luminosityDistance": null,
      "galLat": -25.1, "galLon": 180.5,
      "sunDistance": 90.0, "moonDistance": 90.0,
      "latencyUs": "2500000",
      "createdAt": "2026-06-14T12:00:02.000Z",
      "lifecycle": "preliminary",
      "alertType": "ALERT",
      "classificationTier": null,
      "isHistorical": false,
      "source": "kafka",
      "revisionCount": 0
    }
  ],
  "total": 42
}
```

---

### `GET /api/events/stats`
Aggregate statistics.  
**Auth:** None

**Response:**
```json
{
  "totalEvents": 42,
  "byType": { "GRB": 20, "GW": 10, "FRB": 12 },
  "byObservatory": [],
  "recentRate": 3,
  "latestEvent": { ...event }
}
```
**Known bugs:** `byObservatory` always `[]`. `NU` not in `byType`.

---

### `GET /api/events/:id`
Single event by numeric ID.  
**Auth:** None

**Errors:**
```json
{ "error": "Event not found" }    // 404
{ "error": "ID must be numeric" } // 400
```

---

### `POST /api/auth/register`
Email/password registration. First user → admin. Others require invitation.

**Request:** `{ "email": "...", "password": "...", "name": "..." }`  
**Response (201):** `{ "token": "<JWT>", "user": { "id", "email", "name", "role" } }`  
**Errors:** 400 (validation), 403 (no invitation), 409 (email exists)

---

### `POST /api/auth/login`
**Request:** `{ "email": "...", "password": "..." }`  
**Response:** `{ "token": "<JWT>", "user": {...} }`  
**Errors:** 400, 401

---

### `POST /api/auth/google`
Google OAuth via ID token.  
**Request:** `{ "token": "<Google ID token>" }`  
**Response:** `{ "token": "<JWT>", "user": {...} }`

---

### `POST /api/auth/orcid`
ORCID OAuth via authorization code.  
**Request:** `{ "code": "<auth code>", "redirectUri": "https://..." }`  
**Response:** `{ "token": "<JWT>", "user": { ...includes "orcidId" } }`

---

### `GET /api/auth/me`
Current user from JWT.  
**Auth:** `Authorization: Bearer <JWT>` required  
**Response:** `{ "userId": "...", "email": "...", "role": "..." }`

---

### `GET /api/filter-report`
Real-time filter statistics.  
**Auth:** None

**Response:**
```json
{
  "uptimeSeconds": 3600,
  "totalReceived": 100,
  "totalAccepted": 45,
  "totalRejected": 55,
  "acceptRate": 45.0,
  "byTopic": { "igwn.gwalert": { "received": 10, "accepted": 5, "rejected": 5 } },
  "rejectedByCategory": { "test_trigger": 20, "sub_threshold": 15 },
  "rejectedByReason": [{ "reason": "...", "count": 5, "topic": "...", "lastEventId": "..." }]
}
```

---

### Team / Lab Routes (`/api/team/*`)
CRUD for labs and members. All require auth. Backend complete, minimal frontend integration.

### Bookmarks (`/api/bookmarks/*`)
User-scoped event bookmarks. Requires auth. Backend complete.

### Discussions (`/api/discussions/*`)
Threaded event comments. Requires auth. Backend complete.

---

## WebSocket Endpoint

**URL:** `ws://localhost:8000/api/ws` (dev) / `ws://api-server:8000/api/ws` (Docker)

### Server → Client Messages

| Type | When | Key Fields |
|---|---|---|
| `connection_ack` | On connect | `session_id`, `subscribed_topics`, `heartbeat_interval` |
| `alert` | New accepted GCN event | `sequence`, `event`, `notification.priority` |
| `event_updated` | Event revised | `sequence`, `event` (updated `revision_count`) |
| `heartbeat` | Every 30s | `listener_alive`, `kafka_connected` (⚠️ always `true`) |

### Client → Server Messages

| Type | Purpose |
|---|---|
| `ping` | Keep-alive → server responds `pong` |
| `history_request` | Buffered events since ISO timestamp |
| `ack` | Guaranteed-delivery (no-op in v1) |

---

## Python Backend Endpoints (port 8001 — internal only)

| Endpoint | Notes |
|---|---|
| `GET /` | Status check |
| `GET /health` | Health probe (used by Docker healthcheck) |
| `GET /api/events` | Reads `historical_events.json` — bypassed by Node.js |
| `WS /api/ws` | Main consumer endpoint — Node.js bridges here |

---

## Authentication

All protected routes require:
```
Authorization: Bearer <JWT>
```

JWT payload: `{ userId, email, role, labId, iat, exp }`  
Signed with `JWT_SECRET` (HS256). No refresh tokens — short-lived, re-login required.

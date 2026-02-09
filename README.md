# OpenClaw Spine (v0)

A tiny file-backed job queue with per-agent bearer tokens.

- Port: `36725` (default)
- Health: `GET /health`
- Data dir: `./data/{jobs,events,blobs}`

## Auth
Send `Authorization: Bearer <TOKEN>`.

Roles:
- `head` — `HEAD_TOKEN` (single) or `HEAD_TOKENS` (CSV for rotation)
- `left_claw` — `LEFT_CLAW_TOKEN` or `LEFT_CLAW_TOKENS` (CSV)
- `right_claw` — `RIGHT_CLAW_TOKEN` or `RIGHT_CLAW_TOKENS` (CSV)

### Token Rotation
To rotate tokens without downtime, set the CSV env to include both old and new tokens:
```
HEAD_TOKENS=old-token,new-token
```
Both will be accepted. Remove the old one once all clients have switched.

## Endpoints

| Method | Path | Who | Description |
|--------|------|-----|-------------|
| `GET`  | `/health` | anyone | Health check |
| `POST` | `/jobs` | head | Create job |
| `GET`  | `/jobs` | head + claws | List jobs (filtered by role/target) |
| `GET`  | `/jobs/:id` | head + claws | Get single job |
| `POST` | `/jobs/:id/claim` | claws | Claim a queued job (increments attempts) |
| `POST` | `/jobs/:id/heartbeat` | owner/head | Extend lease |
| `POST` | `/jobs/:id/complete` | owner/head | Mark done |
| `POST` | `/jobs/:id/fail` | owner/head | Fail (requeues by default, or terminal) |
| `POST` | `/jobs/:id/release` | owner/head | Release back to queued (no attempt increment) |
| `POST` | `/jobs/:id/comment` | head + claws | Add a comment |
| `POST` | `/blobs` | head + claws | Upload blob (multipart) |

### Ownership
Only the current claimant (the claw that called `/claim`) can call `/heartbeat`, `/complete`, `/fail`, and `/release` on a running job. **Head always has admin override** on these endpoints.

### Job Lifecycle
```
queued → (claim) → running → (complete) → done
                           → (fail, requeue=true) → queued  (retry)
                           → (fail, requeue=false) → failed
                           → (fail, max attempts) → dead
                           → (release) → queued
                           → (lease expires, reaper) → queued / dead
```

### Attempts & maxAttempts
- Each `/claim` increments `attempts` by 1.
- If `attempts >= maxAttempts` at claim time, the job is marked `dead`.
- `/fail` with `requeue: true` (default) returns to queued if under limit.
- `/release` does NOT increment attempts (it's a voluntary give-back).
- Default `maxAttempts`: 5 (set via `DEFAULT_MAX_ATTEMPTS` env).
- Override per-job in `POST /jobs` body: `{ maxAttempts: 10 }`.

### Expiry Reaper
A background loop (every `REAPER_INTERVAL_MS`, default 30s) scans running jobs with expired leases and:
- Returns them to `queued` if under `maxAttempts`
- Marks them `dead` if at the limit

### Fail Endpoint
`POST /jobs/:id/fail`
```json
{ "error": "reason string", "requeue": true }
```
- `requeue` defaults to `true`. If true and under maxAttempts, returns to queued.
- If false or at maxAttempts, goes to `failed` or `dead`.

### Release Endpoint
`POST /jobs/:id/release`
```json
{ "reason": "optional reason" }
```
Returns a running job to queued without counting as a failure.

## Env
| Var | Default | Description |
|-----|---------|-------------|
| `SPINE_PORT` | `36725` | Listen port |
| `SPINE_HOST` | `127.0.0.1` | Listen host |
| `SPINE_DATA_DIR` | `./data` | Data directory |
| `LEASE_SECONDS` | `300` | Lease duration per claim/heartbeat |
| `REAPER_INTERVAL_MS` | `30000` | Expiry reaper scan interval |
| `DEFAULT_MAX_ATTEMPTS` | `5` | Default max claim attempts |
| `HEAD_TOKEN` | — | Single head token |
| `HEAD_TOKENS` | — | CSV head tokens (rotation) |
| `LEFT_CLAW_TOKEN` | — | Single left claw token |
| `LEFT_CLAW_TOKENS` | — | CSV left claw tokens |
| `RIGHT_CLAW_TOKEN` | — | Single right claw token |
| `RIGHT_CLAW_TOKENS` | — | CSV right claw tokens |

## Run
```bash
cd spine
npm i
npm run start      # production
npm run dev        # with .env file
npm test           # integration tests (47 tests)
```

## Storage
- All writes use temp-file + `rename()` for atomicity.
- Claims use exclusive lock files (`<id>.lock`) to prevent races.
- Events append to `events/<id>.jsonl`.

---
name: spinal-cord
description: File-backed HTTP job queue (“spine”) for coordinating OpenClaw head and claw machines. Use when you need to submit jobs, let a claw poll/claim/heartbeat/complete/fail/release work, or inspect job status/results via the Spine API.
---

# Spinal Cord (Spine) — Job Queue

This skill documents how to talk to a running Spine server over HTTP.

## Config (per agent)
Set these env vars in the environment where the agent/tooling runs:

- `SPINE_BASE_URL` (example: `http://192.168.68.66:36725`)
- `SPINE_TOKEN` (Bearer token for this role)

## Quick usage patterns

### Head pattern (submit → monitor → feedback)
1) `POST /jobs` with `target` + `spec`
2) `GET /jobs` until status is `done` / `failed` / `dead`
3) `POST /jobs/:id/comment` with feedback, or submit a follow-up job

### Claw pattern (poll → claim → heartbeat → complete)
1) `GET /jobs?status=queued&target=left-claw` (or your target)
2) `POST /jobs/:id/claim`
3) While working: `POST /jobs/:id/heartbeat` every ~1–2 minutes
4) Finish with one of:
   - `POST /jobs/:id/complete`
   - `POST /jobs/:id/fail` (optionally requeue)
   - `POST /jobs/:id/release`

## API quick reference

### Health
- `GET /health`

### Skill doc
- `GET /skill.md` (public)

### Jobs
- `POST /jobs` (head)
  - body: `{ target, spec, meta?, maxAttempts? }`
- `GET /jobs` (head + claws)
  - query: `status`, `target`
- `GET /jobs/:id`
- `POST /jobs/:id/claim` (claws)
- `POST /jobs/:id/heartbeat` (owner / head override)
  - body: `{ progress? }`
- `POST /jobs/:id/complete` (owner / head override)
  - body: `{ result? }`
- `POST /jobs/:id/fail` (owner / head override)
  - body: `{ error?, requeue?: boolean }`
- `POST /jobs/:id/release` (owner / head override)
- `POST /jobs/:id/comment` (head + claws)
  - body: `{ text }`

### Blobs
- `POST /blobs` (multipart)
  - field: `file`

## Integrating Spine into OpenClaw (Head + Claws)

Spine is pull-based. The "push" is: the Head submits jobs to Spine, and each Claw runs a polling worker loop to claim/execute work.

### 1) Install/refresh the skill on each machine
Point OpenClaw at the running Spine server’s skill doc:

- `http://<spine-host>:36725/skill.md`

Recommended: treat this as the source of truth. If the skill changes, machines can re-fetch it.

### 2) Configure env vars per role
Each agent/runtime that talks to Spine needs:

- `SPINE_BASE_URL=http://<spine-host>:36725`
- `SPINE_TOKEN=<role token>`
  - Head uses `HEAD_TOKEN`
  - Left claw uses `LEFT_CLAW_TOKEN`
  - Right claw uses `RIGHT_CLAW_TOKEN`

### 3) Claw worker loop (cron + local state)
On each claw machine (e.g. atgsilver), run a cron/launchd job every ~60s.

Use a local state file so work survives across cron ticks:
- `~/.spine/current-job.json`

**Algorithm (each tick):**
1. If `current-job.json` exists:
   - heartbeat the job (`POST /jobs/:id/heartbeat`)
   - advance/check your internal build phases
   - if done → `complete`; if failed → `fail` (optionally requeue); if giving up → `release`
   - when finished, delete `current-job.json`
2. If `current-job.json` does not exist:
   - list queued jobs for your target (`GET /jobs?status=queued&target=left-claw`)
   - claim one (`POST /jobs/:id/claim`)
   - write `current-job.json`
   - start phase 1 (or start a long-running worker)

**Two execution modes:**
- **Long-running worker:** cron claims a job, spawns a background worker that runs phases 1→2→3 and heartbeats on a timer.
- **Cron-advanced phases:** each cron tick runs the next phase and persists progress; every tick heartbeats.

### 4) Reporting results (workers)
When a worker finishes, it should call `POST /jobs/:id/complete` with a structured `result` payload so the Head can review quickly.

Recommended `result` shape:
```json
{
  "url": "https://…", 
  "pr": "https://github.com/…/pull/123",
  "branch": "spine/job-abc",
  "notes": "What changed and why",
  "howToTest": [
    "Step 1…",
    "Step 2…"
  ],
  "artifacts": [
    { "name": "build-log", "url": "https://…" },
    { "name": "bundle.zip", "url": "https://…" }
  ]
}
```
Keep it small and human-readable; link out to large logs/artifacts.

### 5) Head loop (submit + review)
The head submits jobs and monitors results:
- `POST /jobs` to create
- `GET /jobs` / `GET /jobs/:id` to watch
- read `job.result` (URL/PR/notes/howToTest)
- `POST /jobs/:id/comment` to provide feedback / next steps

## Notes
- Only the claimant can heartbeat/complete/fail/release; head has admin override.
- Jobs use a lease; reaper returns expired jobs to `queued` (or marks `dead` at max attempts).
- Token rotation supported server-side via `*_TOKENS` CSV env vars.

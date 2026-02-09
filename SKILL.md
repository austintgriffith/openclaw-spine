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

## Notes
- Only the claimant can heartbeat/complete/fail/release; head has admin override.
- Jobs use a lease; reaper returns expired jobs to `queued` (or marks `dead` at max attempts).
- Token rotation supported server-side via `*_TOKENS` CSV env vars.

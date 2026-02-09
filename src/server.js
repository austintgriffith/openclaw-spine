import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import { nanoid } from 'nanoid';
import fs from 'node:fs/promises';
import path from 'node:path';

/* ─── helpers ─── */

function mustEnv(name, fallback) {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === null || v === '') throw new Error(`Missing env ${name}`);
  return v;
}

function optEnv(name, fallback = '') {
  return process.env[name] ?? fallback;
}

/* ─── config ─── */

const PORT          = parseInt(mustEnv('SPINE_PORT', '36725'), 10);
const HOST          = mustEnv('SPINE_HOST', '127.0.0.1');
const DATA_DIR      = mustEnv('SPINE_DATA_DIR', path.resolve('data'));
const LEASE_SECONDS = parseInt(mustEnv('LEASE_SECONDS', '300'), 10);
const REAPER_INTERVAL_MS = parseInt(optEnv('REAPER_INTERVAL_MS', '30000'), 10);
const DEFAULT_MAX_ATTEMPTS = parseInt(optEnv('DEFAULT_MAX_ATTEMPTS', '5'), 10);

/* ─── token rotation support ───
 * Accepts either single-value env (HEAD_TOKEN) or CSV env (HEAD_TOKENS).
 * Both may coexist; they merge. This lets you rotate tokens without downtime.
 */

function parseTokens(singleKey, csvKey) {
  const tokens = [];
  const single = optEnv(singleKey);
  if (single) tokens.push(single);
  const csv = optEnv(csvKey);
  if (csv) {
    for (const t of csv.split(',')) {
      const trimmed = t.trim();
      if (trimmed && !tokens.includes(trimmed)) tokens.push(trimmed);
    }
  }
  return tokens;
}

const HEAD_TOKENS       = parseTokens('HEAD_TOKEN', 'HEAD_TOKENS');
const LEFT_CLAW_TOKENS  = parseTokens('LEFT_CLAW_TOKEN', 'LEFT_CLAW_TOKENS');
const RIGHT_CLAW_TOKENS = parseTokens('RIGHT_CLAW_TOKEN', 'RIGHT_CLAW_TOKENS');

if (!HEAD_TOKENS.length)       throw new Error('No head tokens configured (set HEAD_TOKEN or HEAD_TOKENS)');
if (!LEFT_CLAW_TOKENS.length)  throw new Error('No left_claw tokens configured');
if (!RIGHT_CLAW_TOKENS.length) throw new Error('No right_claw tokens configured');

const ROLES_BY_TOKEN = new Map();
for (const t of HEAD_TOKENS)       ROLES_BY_TOKEN.set(t, 'head');
for (const t of LEFT_CLAW_TOKENS)  ROLES_BY_TOKEN.set(t, 'left_claw');
for (const t of RIGHT_CLAW_TOKENS) ROLES_BY_TOKEN.set(t, 'right_claw');

/* ─── paths ─── */

const JOBS_DIR   = path.join(DATA_DIR, 'jobs');
const EVENTS_DIR = path.join(DATA_DIR, 'events');
const BLOBS_DIR  = path.join(DATA_DIR, 'blobs');

async function ensureDirs() {
  await fs.mkdir(JOBS_DIR, { recursive: true });
  await fs.mkdir(EVENTS_DIR, { recursive: true });
  await fs.mkdir(BLOBS_DIR, { recursive: true });
}

/* ─── utilities ─── */

function nowIso() { return new Date().toISOString(); }

function roleToClaimer(role) {
  if (role === 'left_claw')  return 'left-claw';
  if (role === 'right_claw') return 'right-claw';
  return 'head';
}

function authRole(req) {
  const h = req.headers.authorization || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  return ROLES_BY_TOKEN.get(m[1]) || null;
}

function requireRole(allowed) {
  return async (req, reply) => {
    const role = authRole(req);
    if (!role || (allowed && !allowed.includes(role))) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    req.role = role;
  };
}

/* ─── file I/O (atomic writes via temp+rename) ─── */

async function readJob(id) {
  const p = path.join(JOBS_DIR, `${id}.json`);
  const raw = await fs.readFile(p, 'utf8');
  return JSON.parse(raw);
}

async function writeJobAtomic(id, job) {
  const p   = path.join(JOBS_DIR, `${id}.json`);
  const tmp = path.join(JOBS_DIR, `${id}.json.tmp.${process.pid}.${Date.now()}`);
  const data = JSON.stringify(job, null, 2);
  await fs.writeFile(tmp, data, 'utf8');
  await fs.rename(tmp, p);
}

async function appendEvent(id, event) {
  const p = path.join(EVENTS_DIR, `${id}.jsonl`);
  await fs.appendFile(p, JSON.stringify(event) + '\n', 'utf8');
}

/* ─── access helpers ─── */

function canAccessJob(role, job) {
  if (role === 'head') return true;
  if (role === 'left_claw')  return job.target === 'left-claw' || job.target === 'any';
  if (role === 'right_claw') return job.target === 'right-claw' || job.target === 'any';
  return false;
}

/** Only the current claimant (or head as admin override) may mutate a running job. */
function isOwnerOrHead(role, job) {
  if (role === 'head') return true;
  const claimer = roleToClaimer(role);
  return job.claimedBy === claimer;
}

function isLeaseValid(job) {
  if (!job.leaseUntil) return false;
  return new Date(job.leaseUntil).getTime() > Date.now();
}

/* ─── Fastify setup ─── */

const fastify = Fastify({ logger: true });
await fastify.register(cors, { origin: true });
await fastify.register(multipart);

fastify.get('/health', async () => ({ ok: true, time: nowIso() }));
fastify.get('/healthz', async () => ({ ok: true, time: nowIso() }));  // deprecated alias

/* ─── POST /jobs (head only) ─── */

fastify.post('/jobs', { preHandler: requireRole(['head']) }, async (req, reply) => {
  const body = req.body || {};
  const target      = body.target || 'left-claw';
  const spec        = body.spec || '';
  const meta        = body.meta || {};
  const maxAttempts = typeof body.maxAttempts === 'number' ? body.maxAttempts : DEFAULT_MAX_ATTEMPTS;

  const id = nanoid();
  const job = {
    id,
    target,
    status: 'queued',
    createdAt: nowIso(),
    updatedAt: nowIso(),
    createdBy: 'head',
    claimedBy: null,
    leaseUntil: null,
    attempts: 0,
    maxAttempts,
    spec,
    meta,
    comments: [],
    result: null,
    error: null,
  };
  await writeJobAtomic(id, job);
  await appendEvent(id, { t: nowIso(), type: 'job.created', by: 'head', target });
  return reply.code(201).send(job);
});

/* ─── GET /jobs ─── */

fastify.get('/jobs', { preHandler: requireRole(['head', 'left_claw', 'right_claw']) }, async (req) => {
  const role   = req.role;
  const q      = req.query || {};
  const status = q.status;
  const target = q.target;

  const files = await fs.readdir(JOBS_DIR);
  const jobs  = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    const raw = await fs.readFile(path.join(JOBS_DIR, f), 'utf8');
    const job = JSON.parse(raw);
    if (role !== 'head' && !canAccessJob(role, job)) continue;
    if (status && job.status !== status) continue;
    if (target && job.target !== target) continue;
    jobs.push(job);
  }
  jobs.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  return { jobs };
});

/* ─── GET /jobs/:id ─── */

fastify.get('/jobs/:id', { preHandler: requireRole(['head', 'left_claw', 'right_claw']) }, async (req, reply) => {
  const role = req.role;
  const id   = req.params.id;
  let job;
  try { job = await readJob(id); } catch { return reply.code(404).send({ error: 'not_found' }); }
  if (!canAccessJob(role, job)) return reply.code(403).send({ error: 'forbidden' });
  return job;
});

/* ─── POST /jobs/:id/claim (claws) ─── */

fastify.post('/jobs/:id/claim', { preHandler: requireRole(['left_claw', 'right_claw']) }, async (req, reply) => {
  const role    = req.role;
  const id      = req.params.id;
  const claimer = roleToClaimer(role);

  const lockPath = path.join(JOBS_DIR, `${id}.lock`);
  let fd;
  try {
    fd = await fs.open(lockPath, 'wx');
  } catch {
    return reply.code(409).send({ error: 'locked' });
  }

  try {
    let job;
    try { job = await readJob(id); } catch { return reply.code(404).send({ error: 'not_found' }); }
    if (!canAccessJob(role, job)) return reply.code(403).send({ error: 'forbidden' });

    // Must be queued to claim
    if (job.status !== 'queued') {
      if (job.status === 'running' && isLeaseValid(job)) {
        return reply.code(409).send({ error: 'already_claimed', claimedBy: job.claimedBy, leaseUntil: job.leaseUntil });
      }
      if (job.status === 'done' || job.status === 'failed' || job.status === 'dead') {
        return reply.code(409).send({ error: 'terminal_status', status: job.status });
      }
    }

    // Enforce maxAttempts
    const maxAttempts = job.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    if (job.attempts >= maxAttempts) {
      job.status = 'dead';
      job.updatedAt = nowIso();
      await writeJobAtomic(id, job);
      await appendEvent(id, { t: nowIso(), type: 'job.dead', by: 'system', reason: 'max_attempts_reached', attempts: job.attempts });
      return reply.code(409).send({ error: 'max_attempts_reached', attempts: job.attempts, maxAttempts });
    }

    job.status     = 'running';
    job.claimedBy  = claimer;
    job.leaseUntil = new Date(Date.now() + LEASE_SECONDS * 1000).toISOString();
    job.attempts   = (job.attempts || 0) + 1;
    job.updatedAt  = nowIso();

    await writeJobAtomic(id, job);
    await appendEvent(id, { t: nowIso(), type: 'job.claimed', by: claimer, leaseUntil: job.leaseUntil, attempt: job.attempts });
    return job;
  } finally {
    try { await fd?.close(); } catch {}
    try { await fs.unlink(lockPath); } catch {}
  }
});

/* ─── POST /jobs/:id/heartbeat ─── */

fastify.post('/jobs/:id/heartbeat', { preHandler: requireRole(['head', 'left_claw', 'right_claw']) }, async (req, reply) => {
  const role = req.role;
  const id   = req.params.id;
  const body = req.body || {};

  let job;
  try { job = await readJob(id); } catch { return reply.code(404).send({ error: 'not_found' }); }
  if (!canAccessJob(role, job)) return reply.code(403).send({ error: 'forbidden' });
  if (!isOwnerOrHead(role, job)) return reply.code(403).send({ error: 'not_owner' });
  if (job.status !== 'running') return reply.code(409).send({ error: 'not_running', status: job.status });

  const claimer = roleToClaimer(role);
  job.leaseUntil = new Date(Date.now() + LEASE_SECONDS * 1000).toISOString();
  job.updatedAt  = nowIso();
  if (body.progress !== undefined) job.progress = body.progress;

  await writeJobAtomic(id, job);
  await appendEvent(id, { t: nowIso(), type: 'job.heartbeat', by: claimer, progress: body.progress ?? null });
  return job;
});

/* ─── POST /jobs/:id/complete ─── */

fastify.post('/jobs/:id/complete', { preHandler: requireRole(['head', 'left_claw', 'right_claw']) }, async (req, reply) => {
  const role = req.role;
  const id   = req.params.id;
  const body = req.body || {};

  let job;
  try { job = await readJob(id); } catch { return reply.code(404).send({ error: 'not_found' }); }
  if (!canAccessJob(role, job)) return reply.code(403).send({ error: 'forbidden' });
  if (!isOwnerOrHead(role, job)) return reply.code(403).send({ error: 'not_owner' });
  if (job.status !== 'running') return reply.code(409).send({ error: 'not_running', status: job.status });

  const claimer = roleToClaimer(role);
  job.status     = 'done';
  job.result     = body.result || null;
  job.error      = null;
  job.leaseUntil = null;
  job.updatedAt  = nowIso();

  await writeJobAtomic(id, job);
  await appendEvent(id, { t: nowIso(), type: 'job.completed', by: claimer, status: 'done' });
  return job;
});

/* ─── POST /jobs/:id/fail ─── */

fastify.post('/jobs/:id/fail', { preHandler: requireRole(['head', 'left_claw', 'right_claw']) }, async (req, reply) => {
  const role = req.role;
  const id   = req.params.id;
  const body = req.body || {};

  let job;
  try { job = await readJob(id); } catch { return reply.code(404).send({ error: 'not_found' }); }
  if (!canAccessJob(role, job)) return reply.code(403).send({ error: 'forbidden' });
  if (!isOwnerOrHead(role, job)) return reply.code(403).send({ error: 'not_owner' });
  if (job.status !== 'running') return reply.code(409).send({ error: 'not_running', status: job.status });

  const claimer    = roleToClaimer(role);
  const maxAttempts = job.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const requeue    = body.requeue !== false && job.attempts < maxAttempts;

  if (requeue) {
    // Return to queued so another worker (or the same one) can retry
    job.status     = 'queued';
    job.claimedBy  = null;
    job.leaseUntil = null;
    job.error      = body.error || null;
  } else {
    // Terminal failure
    job.status     = job.attempts >= maxAttempts ? 'dead' : 'failed';
    job.leaseUntil = null;
    job.error      = body.error || null;
  }
  job.updatedAt = nowIso();

  await writeJobAtomic(id, job);
  await appendEvent(id, { t: nowIso(), type: 'job.failed', by: claimer, requeued: requeue, attempt: job.attempts, error: body.error || null });
  return job;
});

/* ─── POST /jobs/:id/release ─── */

fastify.post('/jobs/:id/release', { preHandler: requireRole(['head', 'left_claw', 'right_claw']) }, async (req, reply) => {
  const role = req.role;
  const id   = req.params.id;
  const body = req.body || {};

  let job;
  try { job = await readJob(id); } catch { return reply.code(404).send({ error: 'not_found' }); }
  if (!canAccessJob(role, job)) return reply.code(403).send({ error: 'forbidden' });
  if (!isOwnerOrHead(role, job)) return reply.code(403).send({ error: 'not_owner' });
  if (job.status !== 'running') return reply.code(409).send({ error: 'not_running', status: job.status });

  const claimer = roleToClaimer(role);

  // Release returns to queued without incrementing attempts (it wasn't a failure, just a release)
  job.status     = 'queued';
  job.claimedBy  = null;
  job.leaseUntil = null;
  job.updatedAt  = nowIso();
  if (body.reason) job.releaseReason = body.reason;

  await writeJobAtomic(id, job);
  await appendEvent(id, { t: nowIso(), type: 'job.released', by: claimer, reason: body.reason || null });
  return job;
});

/* ─── POST /jobs/:id/comment ─── */

fastify.post('/jobs/:id/comment', { preHandler: requireRole(['head', 'left_claw', 'right_claw']) }, async (req, reply) => {
  const role = req.role;
  const id   = req.params.id;
  const body = req.body || {};

  let job;
  try { job = await readJob(id); } catch { return reply.code(404).send({ error: 'not_found' }); }
  if (!canAccessJob(role, job)) return reply.code(403).send({ error: 'forbidden' });

  const by = roleToClaimer(role);
  const comment = { t: nowIso(), by, text: body.text || '' };
  job.comments = Array.isArray(job.comments) ? job.comments : [];
  job.comments.push(comment);
  job.updatedAt = nowIso();

  await writeJobAtomic(id, job);
  await appendEvent(id, { t: nowIso(), type: 'job.comment', by });
  return job;
});

/* ─── POST /blobs ─── */

fastify.post('/blobs', { preHandler: requireRole(['head', 'left_claw', 'right_claw']) }, async (req, reply) => {
  const part = await req.file();
  if (!part) return reply.code(400).send({ error: 'missing_file' });

  const buf = await part.toBuffer();
  const id  = nanoid();
  const ext = path.extname(part.filename || '') || '';
  const out = path.join(BLOBS_DIR, `${id}${ext}`);
  await fs.writeFile(out, buf);
  return { id, filename: part.filename, size: buf.length, path: out };
});

/* ─── Expiry Reaper ───
 * Runs on a timer. Scans all jobs with status=running and expired leases,
 * then returns them to queued (or marks dead if maxAttempts reached).
 */

async function runReaper() {
  try {
    const files = await fs.readdir(JOBS_DIR);
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      const id = f.replace('.json', '');
      try {
        const raw = await fs.readFile(path.join(JOBS_DIR, f), 'utf8');
        const job = JSON.parse(raw);

        if (job.status !== 'running') continue;
        if (isLeaseValid(job)) continue;

        // Lease expired
        const maxAttempts = job.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
        if (job.attempts >= maxAttempts) {
          job.status     = 'dead';
          job.leaseUntil = null;
          job.updatedAt  = nowIso();
          await writeJobAtomic(id, job);
          await appendEvent(id, { t: nowIso(), type: 'job.dead', by: 'reaper', reason: 'lease_expired_max_attempts', attempts: job.attempts });
          fastify.log.info({ jobId: id }, 'reaper: job marked dead (max attempts after lease expiry)');
        } else {
          job.status     = 'queued';
          job.claimedBy  = null;
          job.leaseUntil = null;
          job.updatedAt  = nowIso();
          await writeJobAtomic(id, job);
          await appendEvent(id, { t: nowIso(), type: 'job.expired', by: 'reaper', attempt: job.attempts });
          fastify.log.info({ jobId: id }, 'reaper: expired lease → queued');
        }
      } catch (err) {
        fastify.log.warn({ jobId: id, err: err.message }, 'reaper: error processing job');
      }
    }
  } catch (err) {
    fastify.log.warn({ err: err.message }, 'reaper: scan error');
  }
}

/* ─── start ─── */

await ensureDirs();

const reaperTimer = setInterval(runReaper, REAPER_INTERVAL_MS);
fastify.addHook('onClose', () => clearInterval(reaperTimer));

// Run reaper once at startup
runReaper();

await fastify.listen({ port: PORT, host: HOST });

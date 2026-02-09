/**
 * Spine v0 integration tests.
 *
 * Run:
 *   node test/spine.test.js
 *
 * Requires the server to NOT be running on port 36799 (we start our own).
 * Uses a temp data dir that's cleaned up afterwards.
 */

import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SpineClient } from '../src/client.js';

const PORT = 36799;
const BASE = `http://127.0.0.1:${PORT}`;

const HEAD_TOKEN  = 'test-head-token';
const HEAD_TOKEN2 = 'test-head-token-rotated';
const LC_TOKEN    = 'test-lc-token';
const RC_TOKEN    = 'test-rc-token';

let server;
let tmpDir;

const head = new SpineClient(BASE, HEAD_TOKEN);
const head2 = new SpineClient(BASE, HEAD_TOKEN2);   // rotated token
const lc   = new SpineClient(BASE, LC_TOKEN);
const rc   = new SpineClient(BASE, RC_TOKEN);
const bad  = new SpineClient(BASE, 'wrong-token');

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (!cond) { failed++; console.error(`  ✗ ${msg}`); } else { passed++; console.log(`  ✓ ${msg}`); }
}
function assertEq(a, b, msg) { assert(a === b, `${msg} (got ${JSON.stringify(a)}, expected ${JSON.stringify(b)})`); }

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const SKILL_MD_CONTENT = `---
name: test-skill
---

# Test Skill

This is a test skill markdown file.
`;

async function startServer() {
  tmpDir = await mkdtemp(path.join(tmpdir(), 'spine-test-'));
  const skillMdPath = path.join(tmpDir, 'SKILL.md');
  await writeFile(skillMdPath, SKILL_MD_CONTENT, 'utf8');
  const env = {
    ...process.env,
    SPINE_PORT: String(PORT),
    SPINE_HOST: '127.0.0.1',
    SPINE_DATA_DIR: tmpDir,
    SPINE_SKILL_MD_PATH: skillMdPath,
    HEAD_TOKEN,
    HEAD_TOKENS: `${HEAD_TOKEN},${HEAD_TOKEN2}`,
    LEFT_CLAW_TOKEN: LC_TOKEN,
    RIGHT_CLAW_TOKEN: RC_TOKEN,
    LEASE_SECONDS: '3',           // short lease for testing expiry reaper
    REAPER_INTERVAL_MS: '1000',
    DEFAULT_MAX_ATTEMPTS: '3',
  };
  server = spawn('node', ['src/server.js'], { cwd: path.resolve('.'), env, stdio: 'pipe' });
  server.stderr.on('data', () => {});  // drain
  server.stdout.on('data', () => {});

  // Wait for server to be ready
  for (let i = 0; i < 50; i++) {
    try {
      const r = await head.health();
      if (r.status === 200) return;
    } catch {}
    await sleep(100);
  }
  throw new Error('Server did not start');
}

async function stopServer() {
  server?.kill('SIGTERM');
  await sleep(300);
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
}

/* ─── tests ─── */

async function testHealth() {
  console.log('\n--- health ---');
  const r = await head.health();
  assertEq(r.status, 200, '/health returns 200');
  assert(r.json.ok === true, '/health body ok');
  // deprecated /healthz alias still works
  const rz = await head.healthz();
  assertEq(rz.status, 200, '/healthz deprecated alias returns 200');
  assert(rz.json.ok === true, '/healthz body ok');
}

async function testSkillMd() {
  console.log('\n--- skill.md ---');
  // Public endpoint — no auth needed
  const r = await bad.skillMd();
  assertEq(r.status, 200, '/skill.md returns 200 without auth');
  assert(r.text.includes('# Test Skill'), '/skill.md contains expected content');
  assert(r.text.includes('name: test-skill'), '/skill.md contains frontmatter');
  // Ensure no secrets leak (tokens should not appear in the response)
  assert(!r.text.includes(HEAD_TOKEN), '/skill.md does not leak HEAD_TOKEN');
  assert(!r.text.includes(LC_TOKEN), '/skill.md does not leak LEFT_CLAW_TOKEN');
  assert(!r.text.includes(RC_TOKEN), '/skill.md does not leak RIGHT_CLAW_TOKEN');
}

async function testAuthFails() {
  console.log('\n--- auth ---');
  const r = await bad.listJobs();
  assertEq(r.status, 401, 'bad token → 401');
}

async function testTokenRotation() {
  console.log('\n--- token rotation ---');
  const r = await head2.listJobs();
  assertEq(r.status, 200, 'rotated head token works');
}

async function testCreateAndList() {
  console.log('\n--- create + list ---');
  const r = await head.createJob({ target: 'left-claw', spec: 'do stuff', maxAttempts: 2 });
  assertEq(r.status, 201, 'created 201');
  assertEq(r.json.status, 'queued', 'initial status queued');
  assertEq(r.json.attempts, 0, 'attempts starts at 0');
  assertEq(r.json.maxAttempts, 2, 'maxAttempts preserved');

  const list = await head.listJobs({ status: 'queued' });
  assert(list.json.jobs.some(j => j.id === r.json.id), 'listed in queued');
  return r.json.id;
}

async function testClaimOwnership(jobId) {
  console.log('\n--- claim + ownership ---');
  // right claw cannot claim a left-claw job
  const r1 = await rc.claimJob(jobId);
  assertEq(r1.status, 403, 'wrong claw gets 403');

  // left claw claims it
  const r2 = await lc.claimJob(jobId);
  assertEq(r2.status, 200, 'correct claw claims');
  assertEq(r2.json.status, 'running', 'status → running');
  assertEq(r2.json.attempts, 1, 'attempts incremented to 1');
  assert(r2.json.leaseUntil != null, 'leaseUntil set');

  // right claw cannot heartbeat (not owner)
  const r3 = await rc.heartbeat(jobId, { progress: '50%' });
  assertEq(r3.status, 403, 'non-owner heartbeat → 403');

  // left claw heartbeats ok
  const r4 = await lc.heartbeat(jobId, { progress: '50%' });
  assertEq(r4.status, 200, 'owner heartbeat ok');

  // head can heartbeat as admin override
  const r5 = await head.heartbeat(jobId, { progress: '60%' });
  assertEq(r5.status, 200, 'head heartbeat admin override ok');

  // right claw cannot complete (not owner)
  const r6 = await rc.completeJob(jobId, { result: 'hax' });
  assertEq(r6.status, 403, 'non-owner complete → 403');

  return jobId;
}

async function testRelease(jobId) {
  console.log('\n--- release ---');
  // left claw releases back to queued
  const r = await lc.releaseJob(jobId, { reason: 'cannot do it right now' });
  assertEq(r.status, 200, 'release ok');
  assertEq(r.json.status, 'queued', 'status → queued after release');
  assertEq(r.json.claimedBy, null, 'claimedBy cleared');
  assertEq(r.json.leaseUntil, null, 'leaseUntil cleared');
  return jobId;
}

async function testFailAndRequeue(jobId) {
  console.log('\n--- fail + requeue ---');
  // Re-claim (attempt 2)
  const c = await lc.claimJob(jobId);
  assertEq(c.status, 200, 'second claim ok');
  assertEq(c.json.attempts, 2, 'attempts = 2');

  // Fail with requeue (default behavior, attempt 2 < maxAttempts 2 is false → terminal)
  // maxAttempts=2, attempts=2, so requeue should NOT happen
  const f = await lc.failJob(jobId, { error: 'oops' });
  assertEq(f.status, 200, 'fail ok');
  assertEq(f.json.status, 'dead', 'status → dead (max attempts reached)');

  return jobId;
}

async function testFailRequeue() {
  console.log('\n--- fail with requeue ---');
  // Create a fresh job with higher maxAttempts
  const cr = await head.createJob({ target: 'left-claw', spec: 'retry me', maxAttempts: 5 });
  const id = cr.json.id;

  const c = await lc.claimJob(id);
  assertEq(c.json.attempts, 1, 'attempt 1');

  // Fail with requeue=true (default)
  const f = await lc.failJob(id, { error: 'transient', requeue: true });
  assertEq(f.status, 200, 'fail ok');
  assertEq(f.json.status, 'queued', 'requeued after fail');

  // Claim again
  const c2 = await lc.claimJob(id);
  assertEq(c2.json.attempts, 2, 'attempt 2 after requeue');

  // Complete successfully
  const comp = await lc.completeJob(id, { result: { done: true } });
  assertEq(comp.json.status, 'done', 'completed');
  return id;
}

async function testMaxAttemptsDead() {
  console.log('\n--- maxAttempts → dead ---');
  const cr = await head.createJob({ target: 'left-claw', spec: 'will die', maxAttempts: 1 });
  const id = cr.json.id;

  const c = await lc.claimJob(id);
  assertEq(c.json.attempts, 1, 'attempt 1');

  // Fail → should go dead (attempts 1 >= maxAttempts 1)
  const f = await lc.failJob(id, { error: 'fatal' });
  assertEq(f.json.status, 'dead', 'dead at maxAttempts');

  // Cannot claim dead jobs
  const c2 = await lc.claimJob(id);
  assertEq(c2.status, 409, 'cannot claim dead');
}

async function testExpiryReaper() {
  console.log('\n--- expiry reaper ---');
  const cr = await head.createJob({ target: 'left-claw', spec: 'will expire', maxAttempts: 3 });
  const id = cr.json.id;

  const c = await lc.claimJob(id);
  assertEq(c.json.status, 'running', 'claimed');

  // Lease is 3s, reaper runs every 1s. Wait 5s for it to expire.
  console.log('    (waiting ~5s for lease expiry + reaper...)');
  await sleep(5000);

  const g = await head.getJob(id);
  assertEq(g.json.status, 'queued', 'reaper returned expired job to queued');
  assertEq(g.json.claimedBy, null, 'claimedBy cleared by reaper');
}

async function testHeadCanFail() {
  console.log('\n--- head admin fail ---');
  const cr = await head.createJob({ target: 'left-claw', spec: 'head will fail', maxAttempts: 5 });
  const id = cr.json.id;
  await lc.claimJob(id);
  const f = await head.failJob(id, { error: 'admin override', requeue: false });
  assertEq(f.status, 200, 'head can fail as admin');
  assertEq(f.json.status, 'failed', 'failed by head');
}

async function testHeadCanRelease() {
  console.log('\n--- head admin release ---');
  const cr = await head.createJob({ target: 'left-claw', spec: 'head will release', maxAttempts: 5 });
  const id = cr.json.id;
  await lc.claimJob(id);
  const r = await head.releaseJob(id, { reason: 'admin override' });
  assertEq(r.status, 200, 'head can release as admin');
  assertEq(r.json.status, 'queued', 'released to queued by head');
}

async function testComment() {
  console.log('\n--- comment ---');
  const cr = await head.createJob({ target: 'left-claw', spec: 'comments test' });
  const id = cr.json.id;
  const c = await head.comment(id, { text: 'hello from head' });
  assertEq(c.status, 200, 'comment ok');
  assertEq(c.json.comments.length, 1, '1 comment');
  assertEq(c.json.comments[0].by, 'head', 'comment by head');
}

async function testNotFound() {
  console.log('\n--- 404 ---');
  const r = await head.getJob('nonexistent123');
  assertEq(r.status, 404, 'nonexistent job → 404');
}

async function testAnyTarget() {
  console.log('\n--- target=any ---');
  const cr = await head.createJob({ target: 'any', spec: 'any claw can claim' });
  const id = cr.json.id;
  // Right claw can claim 'any'
  const c = await rc.claimJob(id);
  assertEq(c.status, 200, 'right claw claims any-target');
  const comp = await rc.completeJob(id, { result: 'done' });
  assertEq(comp.json.status, 'done', 'completed by right claw');
}

/* ─── runner ─── */

async function run() {
  try {
    await startServer();
    await testHealth();
    await testSkillMd();
    await testAuthFails();
    await testTokenRotation();
    const jobId = await testCreateAndList();
    await testClaimOwnership(jobId);
    await testRelease(jobId);
    await testFailAndRequeue(jobId);
    await testFailRequeue();
    await testMaxAttemptsDead();
    await testExpiryReaper();
    await testHeadCanFail();
    await testHeadCanRelease();
    await testComment();
    await testNotFound();
    await testAnyTarget();
  } finally {
    await stopServer();
  }
  console.log(`\n═══════════════════════════`);
  console.log(`  ${passed} passed, ${failed} failed`);
  console.log(`═══════════════════════════\n`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => { console.error(err); process.exit(1); });

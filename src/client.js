import http from 'node:http';
import https from 'node:https';

export async function spineRequest(baseUrl, token, { method='GET', path='/', query=null, body=null, headers={} } = {}) {
  const url = new URL(baseUrl);
  const isHttps = url.protocol === 'https:';
  const mod = isHttps ? https : http;

  let fullPath = path;
  if (query) {
    const qs = new URLSearchParams(query);
    fullPath += (fullPath.includes('?') ? '&' : '?') + qs.toString();
  }

  const payload = body ? Buffer.from(JSON.stringify(body)) : null;

  const opts = {
    hostname: url.hostname,
    port: url.port || (isHttps ? 443 : 80),
    path: fullPath,
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
      ...headers,
    },
  };

  return new Promise((resolve, reject) => {
    const req = mod.request(opts, (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch {}
        resolve({ status: res.statusCode, text, json });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/* ─── convenience wrappers ─── */

export class SpineClient {
  constructor(baseUrl, token) {
    this.baseUrl = baseUrl;
    this.token = token;
  }

  _req(opts) { return spineRequest(this.baseUrl, this.token, opts); }

  healthz()                        { return this._req({ path: '/healthz' }); }
  createJob(body)                  { return this._req({ method: 'POST', path: '/jobs', body }); }
  listJobs(query)                  { return this._req({ path: '/jobs', query }); }
  getJob(id)                       { return this._req({ path: `/jobs/${id}` }); }
  claimJob(id)                     { return this._req({ method: 'POST', path: `/jobs/${id}/claim` }); }
  heartbeat(id, body)              { return this._req({ method: 'POST', path: `/jobs/${id}/heartbeat`, body }); }
  completeJob(id, body)            { return this._req({ method: 'POST', path: `/jobs/${id}/complete`, body }); }
  failJob(id, body)                { return this._req({ method: 'POST', path: `/jobs/${id}/fail`, body }); }
  releaseJob(id, body)             { return this._req({ method: 'POST', path: `/jobs/${id}/release`, body }); }
  comment(id, body)                { return this._req({ method: 'POST', path: `/jobs/${id}/comment`, body }); }
}

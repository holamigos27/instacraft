// instaCRAFT shared-data API (Cloudflare Worker + D1)
//   POST /auth  { ticket }           → { token, name, expiresAt }   (ticket = CRAQUES HUB's signed, 60 s, one-time STAFF ticket)
//   POST /rpc   { action, payload }  → { success, data } / { success: false, error }   (Authorization: Bearer <token>)
//   GET  /img/<id>                    → the image (immutable, CORS *)
// Nothing here calls CRAQUES HUB: the ticket is checked with the shared secret only.

const SESSION_MS = 14 * 24 * 3600 * 1000;
const MAX_DOC_CHARS = 1_900_000; // D1 keeps rows up to 2 MB
const MAX_IMAGE_BYTES = 1_950_000;
const SETTING_NAMES = ['team', 'types', 'tagGroups', 'infoFields', 'mentions', 'assets', 'blocks', 'masters'];
const KINDS = new Set(['post', 'preset']);
const MAKE_HOOK = /^https:\/\/hook\.[a-z0-9-]+\.make\.com\/[A-Za-z0-9_-]+$/;
async function makeHook(env) {
  const r = await env.DB.prepare("SELECT value FROM settings WHERE key = '_make'").first();
  return r ? JSON.parse(r.value) : '';
}

const enc = new TextEncoder();
const json = (body, init = {}, cors = {}) =>
  new Response(JSON.stringify(body), { ...init, headers: { 'Content-Type': 'application/json; charset=utf-8', ...cors, ...(init.headers || {}) } });

function corsFor(req, env) {
  const origin = req.headers.get('Origin') || '';
  const allowed = String(env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!allowed.includes(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

const b64urlToBytes = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4)), c => c.charCodeAt(0));
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
const randomToken = () => hex(crypto.getRandomValues(new Uint8Array(32)));

/* CRAQUES HUB ticket: base64url(JSON) + "." + base64url(HMAC-SHA256(body, secret)) */
async function verifyTicket(ticket, secret) {
  const [body, sig] = String(ticket || '').split('.');
  if (!body || !sig || !secret) return null;
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  if (!(await crypto.subtle.verify('HMAC', key, b64urlToBytes(sig), enc.encode(body)))) return null;
  let c;
  try { c = JSON.parse(new TextDecoder().decode(b64urlToBytes(body))); } catch { return null; }
  const now = Math.floor(Date.now() / 1000);
  if (c.iss !== 'craques-hub' || c.aud !== 'instacraft' || c.role !== 'staff' || !c.jti || !(c.exp >= now)) return null;
  return c;
}

async function auth(req, env, cors) {
  const { ticket } = await req.json().catch(() => ({}));
  const c = await verifyTicket(ticket, env.SSO_SECRET);
  if (!c) return json({ success: false, error: '入場券が無効か、期限切れです。管理画面のアイコンから開き直してください。' }, { status: 401 }, cors);
  // one time only
  const now = Date.now();
  await env.DB.prepare('DELETE FROM used_tickets WHERE exp < ?').bind(Math.floor(now / 1000)).run();
  const used = await env.DB.prepare('INSERT OR IGNORE INTO used_tickets (jti, exp) VALUES (?, ?)').bind(c.jti, c.exp).run();
  if (!used.meta.changes) return json({ success: false, error: 'この入場券は使用済みです。管理画面のアイコンから開き直してください。' }, { status: 401 }, cors);
  await env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(now).run();
  const token = randomToken(), expiresAt = now + SESSION_MS;
  await env.DB.prepare('INSERT INTO sessions (token, name, reg, expires_at) VALUES (?, ?, ?, ?)').bind(token, String(c.name || ''), String(c.reg || ''), expiresAt).run();
  return json({ success: true, data: { token, name: c.name, expiresAt } }, {}, cors);
}

async function sessionOf(req, env) {
  const m = /^Bearer ([0-9a-f]{64})$/.exec(req.headers.get('Authorization') || '');
  if (!m) return null;
  const s = await env.DB.prepare('SELECT name, reg, expires_at FROM sessions WHERE token = ?').bind(m[1]).first();
  if (!s || s.expires_at < Date.now()) return null;
  return { token: m[1], name: s.name, reg: s.reg };
}

function kindOf(p) {
  const k = String(p.kind || '');
  if (!KINDS.has(k)) throw new Error('種類が不正です');
  return k;
}
function idOf(v) {
  const s = String(v || '');
  if (!/^[\w-]{4,64}$/.test(s)) throw new Error('ID が不正です');
  return s;
}

const actions = {
  async icList(p, env) {
    const { results } = await env.DB.prepare('SELECT data, version, updated_by FROM docs WHERE kind = ?').bind(kindOf(p)).all();
    return results.map(r => {
      const d = JSON.parse(r.data);
      return { ...d, slides: (d.slides || []).map(s => ({ id: s.id, thumb: s.thumb })), _v: r.version, _by: r.updated_by };
    });
  },
  async icGet(p, env) {
    const r = await env.DB.prepare('SELECT data, version, updated_by FROM docs WHERE kind = ? AND id = ?').bind(kindOf(p), idOf(p.id)).first();
    return r ? { ...JSON.parse(r.data), _v: r.version, _by: r.updated_by } : null;
  },
  // a newer version saved by someone else is never overwritten silently (unless force)
  async icPut(p, env, who) {
    const kind = kindOf(p);
    const { _v, _by, ...doc } = p.doc || {};
    const id = idOf(doc.id);
    const cur = await env.DB.prepare('SELECT version, updated_by, updated_at, data FROM docs WHERE kind = ? AND id = ?').bind(kind, id).first();
    if (cur && !p.force && Number(p.baseVersion || 0) !== cur.version) return { conflict: true, version: cur.version, by: cur.updated_by, at: cur.updated_at };
    // a post that was posted stays posted when a copy opened before posting is saved over it;
    // only an explicit status change (the list's status menu) turns it back into a draft
    let kept = false;
    if (cur && kind === 'post' && !p.statusChange) {
      try {
        const old = JSON.parse(cur.data);
        if (old.status === 'posted' && doc.status !== 'posted') {
          for (const k of ['status', 'postedAt', 'permalink', 'postedTo', 'postedVia']) if (old[k] !== undefined) doc[k] = old[k];
          kept = true;
        }
      } catch (e) { /* unreadable old copy: save as sent */ }
    }
    const data = JSON.stringify(doc);
    if (data.length > MAX_DOC_CHARS) throw new Error('データが大きすぎます（スライドや画像を減らしてください）');
    const version = (cur ? cur.version : 0) + 1;
    await env.DB.prepare(
      'INSERT INTO docs (kind, id, version, updated_at, updated_by, data) VALUES (?,?,?,?,?,?) ON CONFLICT(kind, id) DO UPDATE SET version = excluded.version, updated_at = excluded.updated_at, updated_by = excluded.updated_by, data = excluded.data',
    ).bind(kind, id, version, Date.now(), who.name, data).run();
    return kept ? { version, kept: { status: doc.status, postedAt: doc.postedAt, permalink: doc.permalink } } : { version };
  },
  async icDelete(p, env) {
    await env.DB.prepare('DELETE FROM docs WHERE kind = ? AND id = ?').bind(kindOf(p), idOf(p.id)).run();
    return { deleted: true };
  },
  // same image → same id, stored once
  async icSaveImage(p, env, who, base) {
    const m = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(p.data || ''));
    if (!m) throw new Error('画像が読めません');
    const id = 'ic' + hex(await crypto.subtle.digest('SHA-256', enc.encode(m[2]))).slice(0, 40);
    const bytes = Uint8Array.from(atob(m[2]), c => c.charCodeAt(0));
    if (bytes.length > MAX_IMAGE_BYTES) throw new Error('画像が大きすぎます');
    await env.DB.prepare('INSERT OR IGNORE INTO images (id, mime, data, created_at) VALUES (?,?,?,?)').bind(id, m[1], bytes, Date.now()).run();
    return { url: `${base}/img/${id}` };
  },
  async icGetSettings(p, env) {
    const { results } = await env.DB.prepare('SELECT key, value FROM settings').all();
    // keys starting with "_" are server-side only (the Make webhook)
    return Object.fromEntries(results.filter(r => !r.key.startsWith('_')).map(r => [r.key, JSON.parse(r.value)]));
  },
  /* Instagram posting goes through the team's Make scenario; its webhook URL stays on the server */
  async icGetMake(p, env) {
    const url = await makeHook(env);
    return { configured: !!url, hint: url ? url.replace(/^https:\/\//, '').slice(0, 22) + '…' + url.slice(-4) : '' };
  },
  async icSetMake(p, env) {
    const url = String(p.url || '').trim();
    if (url && !MAKE_HOOK.test(url)) throw new Error('MakeのWebhook URL（https://hook.○○.make.com/…）を入力してください');
    if (url) await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('_make', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(JSON.stringify(url)).run();
    else await env.DB.prepare("DELETE FROM settings WHERE key = '_make'").run();
    return actions.icGetMake(p, env);
  },
  async icSendMake(p, env) {
    const url = await makeHook(env);
    if (!url) throw new Error('MakeのWebhook URLが未設定です');
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p.payload || {}) });
    return { status: r.status, body: (await r.text()).slice(0, 4000) };
  },
  async icSaveSettings(p, env) {
    const s = p.settings || {};
    const stmts = SETTING_NAMES.filter(k => k in s).map(k => {
      const v = JSON.stringify(s[k]);
      if (v.length > 500_000) throw new Error('設定が大きすぎます');
      return env.DB.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind(k, v);
    });
    if (stmts.length) await env.DB.batch(stmts);
    return actions.icGetSettings(p, env);
  },
  async logout(p, env, who) {
    await env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(who.token).run();
    return { loggedOut: true };
  },
};

async function rpc(req, env, cors) {
  const who = await sessionOf(req, env);
  if (!who) return json({ success: false, error: 'LOGIN_REQUIRED' }, { status: 401 }, cors);
  const { action, payload } = await req.json().catch(() => ({}));
  const fn = Object.hasOwn(actions, action) ? actions[action] : null;
  if (!fn) return json({ success: false, error: '不明な操作です: ' + action }, { status: 400 }, cors);
  try {
    return json({ success: true, data: await fn(payload || {}, env, who, new URL(req.url).origin) }, {}, cors);
  } catch (e) {
    return json({ success: false, error: e.message || String(e) }, {}, cors);
  }
}

async function image(req, env, ctx, id) {
  id = id.replace(/\.(jpe?g|png|webp)$/, '');
  if (!/^ic[0-9a-f]{40}$/.test(id)) return new Response('not found', { status: 404 });
  const cache = caches.default;
  const hit = await cache.match(req);
  if (hit) return hit;
  const r = await env.DB.prepare('SELECT mime, data FROM images WHERE id = ?').bind(id).first();
  if (!r) return new Response('not found', { status: 404, headers: { 'Access-Control-Allow-Origin': '*' } });
  const res = new Response(new Uint8Array(r.data), {
    headers: { 'Content-Type': r.mime, 'Cache-Control': 'public, max-age=31536000, immutable', 'Access-Control-Allow-Origin': '*' },
  });
  ctx.waitUntil(cache.put(req, res.clone()));
  return res;
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const cors = corsFor(req, env);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (req.method === 'GET' && url.pathname.startsWith('/img/')) return image(req, env, ctx, url.pathname.slice(5));
    if (req.method === 'POST' && url.pathname === '/auth') return auth(req, env, cors);
    if (req.method === 'POST' && url.pathname === '/rpc') return rpc(req, env, cors);
    if (url.pathname === '/') return json({ service: 'instaCRAFT API', ok: true }, {}, cors);
    return new Response('not found', { status: 404 });
  },
};

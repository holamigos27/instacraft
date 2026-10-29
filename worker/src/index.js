import Anthropic from '@anthropic-ai/sdk';
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

const DESIGN_FONTS = ['Bebas Neue', 'Anton', 'Oswald', 'Montserrat', 'Teko', 'Russo One', 'Noto Sans JP', 'Zen Kaku Gothic New', 'Dela Gothic One', 'Shippori Mincho', 'Grand Hotel'];
const nul = t => ({ anyOf: [t, { type: 'null' }] });
const obj = props => ({ type: 'object', properties: props, required: Object.keys(props), additionalProperties: false });
const DESIGN_SCHEMA = obj({
  background: obj({ description: { type: 'string' }, color: { type: 'string' } }),
  elements: { type: 'array', items: obj({
    kind: { type: 'string', enum: ['text', 'rect', 'ellipse', 'triangle', 'line'] },
    name: { type: 'string' },
    x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' },
    rotation: { type: 'number' },
    text: nul({ type: 'string' }),
    font: nul({ type: 'string', enum: DESIGN_FONTS }),
    weight: nul({ type: 'integer', enum: [400, 500, 700, 800, 900] }),
    italic: { type: 'boolean' },
    align: { type: 'string', enum: ['left', 'center', 'right'] },
    letter_spacing: { type: 'number' },
    line_height: { type: 'number' },
    fill: obj({ type: { type: 'string', enum: ['solid', 'gradient', 'none'] }, color: { type: 'string' }, color2: nul({ type: 'string' }), angle: { type: 'number' } }),
    stroke: nul(obj({ color: { type: 'string' }, width: { type: 'number' } })),
    shadow: nul(obj({ color: { type: 'string' }, blur: { type: 'number' }, offset_x: { type: 'number' }, offset_y: { type: 'number' } })),
    opacity: { type: 'number' },
    corner_radius: { type: 'number' },
  }) },
});
const DESIGN_PROMPT = `This is a social-media graphic ({W}×{H} px). It will be rebuilt as editable layers: the photo/background stays a picture, and every piece of designed lettering and every flat graphic shape you list is removed from the picture and redrawn on top.

List, back to front:
- every piece of designed text (titles, scores, names, dates, captions, small credits). One element per text block; use \n between its lines. Copy the text exactly, including Japanese.
- flat graphic shapes drawn over the picture: solid or gradient bands, boxes, badges, frames, rules, slanted stripes. A slanted band is a rect with its rotation.
Leave out anything that is part of the photographed scene (printing on clothes, signs, logos in the photo), emblems/logos that are pictures, and soft lighting (glows, flares, vignettes) that is not a shape - those stay in the picture.

For each element:
- x, y, w, h: the tight box in pixels of this image, measured before rotation (the box the element would have if turned upright, centred on the same point); rotation in degrees, clockwise positive.
- text: font = the closest of the listed fonts (condensed bold sans → Bebas Neue / Anton / Oswald / Teko; wide geometric → Montserrat / Russo One; Japanese gothic → Noto Sans JP / Zen Kaku Gothic New, heavy Japanese → Dela Gothic One, Japanese serif → Shippori Mincho, script → Grand Hotel); weight; italic if slanted letters; align; letter_spacing in thousandths of the font size (0 normal); line_height as a multiple of the font size.
- fill: the colour as #rrggbb; gradient with color2 and its angle (0 = left→right, 90 = top→bottom) when the fill visibly changes colour; none for outline-only text or frames.
- stroke: outline colour and width in pixels, or null.
- shadow: drop shadow or glow (glow = offsets 0, a large blur), colour as #rrggbb or rgba(), blur and offsets in pixels, or null.
- opacity 0–1; corner_radius in pixels for rounded boxes (0 otherwise).
For shapes, text/font/weight are null, italic false, align "center", letter_spacing 0, line_height 1.
name: a short Japanese label for the layer (例: タイトル, スコア, 日付, 帯).
background: a short description and its main colour.`;

/* Gemini has no strict schema here: the shape is spelled out, and the answer is tidied by normalizeDesign */
const GEMINI_SHAPE = `Answer with JSON only, in this shape:
{"background":{"description":string,"color":"#rrggbb"},
 "elements":[{"kind":"text"|"rect"|"ellipse"|"triangle"|"line","name":string,"box_2d":[ymin,xmin,ymax,xmax],"rotation":number,
   "text":string|null,"font":one of ${JSON.stringify(DESIGN_FONTS)} or null,"weight":400|500|700|800|900|null,"italic":boolean,"align":"left"|"center"|"right",
   "letter_spacing":number,"line_height":number,"fill":{"type":"solid"|"gradient"|"none","color":"#rrggbb","color2":"#rrggbb"|null,"angle":number},
   "stroke":{"color":string,"width":number}|null,"shadow":{"color":string,"blur":number,"offset_x":number,"offset_y":number}|null,"opacity":number,"corner_radius":number}]}
box_2d is the element's bounding box on screen (as drawn, including its rotation), normalised to 0-1000: [ymin, xmin, ymax, xmax]. Stroke widths, blurs and offsets stay in pixels of the image.
List every text you can read - a picture with lettering always has elements.`;
const GEMINI_MODELS = ['gemini-3-flash', 'gemini-3-flash-preview', 'gemini-2.5-flash'];
/* the same shape as Gemini's response schema (OpenAPI style), so it has to answer with these names */
const gS = (type, extra = {}) => ({ type, ...extra }), gN = (t, extra = {}) => ({ ...gS(t, extra), nullable: true });
const gO = (props, req = Object.keys(props)) => ({ type: 'OBJECT', properties: props, required: req });
const GEMINI_SCHEMA = gO({
  background: gO({ description: gS('STRING'), color: gS('STRING') }),
  elements: gS('ARRAY', { items: gO({
    kind: gS('STRING', { enum: ['text', 'rect', 'ellipse', 'triangle', 'line'] }),
    name: gS('STRING'),
    box_2d: gS('ARRAY', { items: gS('NUMBER') }),
    rotation: gS('NUMBER'),
    text: gN('STRING'),
    font: gN('STRING', { enum: DESIGN_FONTS }),
    weight: gN('INTEGER'),
    italic: gS('BOOLEAN'),
    align: gS('STRING', { enum: ['left', 'center', 'right'] }),
    letter_spacing: gS('NUMBER'),
    line_height: gS('NUMBER'),
    fill: gO({ type: gS('STRING', { enum: ['solid', 'gradient', 'none'] }), color: gS('STRING'), color2: gN('STRING'), angle: gS('NUMBER') }),
    stroke: gN('OBJECT', { properties: { color: gS('STRING'), width: gS('NUMBER') }, required: ['color', 'width'] }),
    shadow: gN('OBJECT', { properties: { color: gS('STRING'), blur: gS('NUMBER'), offset_x: gS('NUMBER'), offset_y: gS('NUMBER') }, required: ['color', 'blur', 'offset_x', 'offset_y'] }),
    opacity: gS('NUMBER'),
    corner_radius: gS('NUMBER'),
  }, ['kind', 'name', 'box_2d', 'rotation', 'text', 'fill', 'opacity']) }),
});
async function geminiDesign(env, mime, b64, W, H) {
  const models = env.GEMINI_MODEL ? [env.GEMINI_MODEL] : GEMINI_MODELS;
  const contents = [{ role: 'user', parts: [{ inline_data: { mime_type: mime, data: b64 } }, { text: DESIGN_PROMPT.replace('{W}', W).replace('{H}', H) + '\n\n' + GEMINI_SHAPE }] }];
  // light thinking keeps a busy picture under the time limit (Gemini 3: thinkingLevel, 2.5: thinkingBudget)
  const thinking = model => (/gemini-3/.test(model) ? { thinkingLevel: 'low' } : { thinkingBudget: 1024 });
  let last = '';
  for (const model of models) {
    for (const [withThinking, withSchema] of [[true, true], [false, true], [false, false]]) {
      const generationConfig = { responseMimeType: 'application/json', temperature: 0.2, ...(withSchema ? { responseSchema: GEMINI_SCHEMA } : {}), ...(withThinking ? { thinkingConfig: thinking(model) } : {}) };
      // streamed, so the connection never sits idle long enough to time out
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY }, body: JSON.stringify({ contents, generationConfig }),
      });
      if (r.status === 404) { last = model + ' が見つかりません'; break; } // that model name isn't offered: try the next
      if (r.status === 429) throw new Error('無料枠の上限に達しました。しばらく待ってからもう一度お試しください');
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        if (r.status === 400 && (withThinking || withSchema)) continue; // a setting this model does not take: try without it
        throw new Error('解析サーバーのエラー：' + (j.error?.message || r.status));
      }
      const sse = await r.text();
      let text = '', finish = '';
      for (const line of sse.split('\n')) {
        if (!line.startsWith('data:')) continue;
        try {
          const j = JSON.parse(line.slice(5));
          if (j.error) throw new Error('解析サーバーのエラー：' + (j.error.message || ''));
          const c = j.candidates?.[0];
          text += (c?.content?.parts || []).filter(x => !x.thought).map(x => x.text || '').join('');
          if (c?.finishReason) finish = c.finishReason;
        } catch (e) { if (/解析サーバー/.test(e.message)) throw e; }
      }
      if (!text) throw new Error(finish === 'SAFETY' ? 'この画像は解析できませんでした' : '解析結果が空でした（' + (finish || '不明') + '）');
      try { return JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, '')); }
      catch (e) { throw new Error(finish === 'MAX_TOKENS' ? '要素が多すぎて解析しきれませんでした' : '解析結果を読み取れませんでした'); }
    }
  }
  throw new Error('使えるGeminiのモデルがありません（' + last + '）');
}
/* Gemini's own boxes ([ymin, xmin, ymax, xmax] in 0-1000, as drawn) → x, y, w, h in pixels before rotation */
function fromBox2d(d, W, H) {
  const list = d?.elements || d?.layers || d?.items || (Array.isArray(d) ? d : []);
  const elements = list.map(e0 => {
    // names other models use for the same things
    const e = { ...e0, kind: e0?.kind || e0?.type || e0?.element_type, text: e0?.text ?? e0?.content ?? e0?.value ?? null };
    const bb = e0?.bounding_box || e0?.boundingBox || e0?.position;
    if (bb && !Array.isArray(bb) && typeof bb === 'object') Object.assign(e, { x: bb.x ?? bb.left, y: bb.y ?? bb.top, w: bb.w ?? bb.width, h: bb.h ?? bb.height });
    const b = e?.box_2d || e?.box || e?.bbox || (Array.isArray(bb) ? bb : null);
    if (!Array.isArray(b) || b.length !== 4) return e;
    const [y0, x0, y1, x1] = b.map(Number);
    const bw = (x1 - x0) / 1000 * W, bh = (y1 - y0) / 1000 * H, cx = (x0 + x1) / 2000 * W, cy = (y0 + y1) / 2000 * H;
    // the upright size whose turned box is this one
    const a = Math.abs(((+e.rotation || 0) % 180) * Math.PI / 180), c = Math.abs(Math.cos(a)), s = Math.abs(Math.sin(a)), det = c * c - s * s;
    let w = bw, h = bh;
    if (Math.abs(det) > 0.2) { w = (bw * c - bh * s) / det; h = (bh * c - bw * s) / det; }
    if (!(w > 1) || !(h > 1)) { w = bw; h = bh; }
    return { ...e, x: cx - w / 2, y: cy - h / 2, w, h, _px: true };
  });
  // boxes given as x/y/w/h: fractions (0-1) or a 0-1000 scale are turned into pixels
  const plain = elements.filter(e => !e?._px && Number.isFinite(+e?.w));
  if (plain.length) {
    const maxX = Math.max(...plain.map(e => +e.x + +e.w)), maxY = Math.max(...plain.map(e => +e.y + +e.h));
    let kx = 1, ky = 1;
    if (maxX <= 1.05 && maxY <= 1.05) { kx = W; ky = H; }
    else if ((maxX > W * 1.1 || maxY > H * 1.1) && maxX <= 1000 && maxY <= 1000) { kx = W / 1000; ky = H / 1000; }
    if (kx !== 1) plain.forEach(e => { e.x *= kx; e.w *= kx; e.y *= ky; e.h *= ky; });
  }
  return { ...(Array.isArray(d) ? {} : d), elements };
}
/* fill in what an answer left out, so the page always gets the same shape */
function normalizeDesign(d) {
  const num = (v, def) => (Number.isFinite(+v) ? +v : def);
  const col = (v, def) => (typeof v === 'string' && v.trim() ? v.trim() : def);
  const elements = (Array.isArray(d?.elements) ? d.elements : []).map(e => ({
    kind: ['text', 'rect', 'ellipse', 'triangle', 'line'].includes(e?.kind) ? e.kind : 'rect',
    name: String(e?.name || ''),
    x: num(e?.x, 0), y: num(e?.y, 0), w: num(e?.w, 0), h: num(e?.h, 0), rotation: num(e?.rotation, 0),
    text: e?.text == null ? null : String(e.text),
    font: DESIGN_FONTS.includes(e?.font) ? e.font : null,
    weight: [400, 500, 700, 800, 900].includes(+e?.weight) ? +e.weight : null,
    italic: !!e?.italic,
    align: ['left', 'center', 'right'].includes(e?.align) ? e.align : 'center',
    letter_spacing: num(e?.letter_spacing, 0), line_height: num(e?.line_height, 1.1),
    fill: { type: ['solid', 'gradient', 'none'].includes(e?.fill?.type) ? e.fill.type : 'solid', color: col(e?.fill?.color, '#ffffff'), color2: e?.fill?.color2 ? String(e.fill.color2) : null, angle: num(e?.fill?.angle, 0) },
    stroke: e?.stroke && num(e.stroke.width, 0) > 0 ? { color: col(e.stroke.color, '#000000'), width: num(e.stroke.width, 0) } : null,
    shadow: e?.shadow ? { color: col(e.shadow.color, 'rgba(0,0,0,0.5)'), blur: num(e.shadow.blur, 0), offset_x: num(e.shadow.offset_x, 0), offset_y: num(e.shadow.offset_y, 0) } : null,
    opacity: Math.max(0, Math.min(1, num(e?.opacity, 1))),
    corner_radius: num(e?.corner_radius, 0),
  })).filter(e => e.kind !== 'text' || (e.text && e.text.trim()));
  return { background: { description: String(d?.background?.description || ''), color: col(d?.background?.color, '#000000') }, elements };
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
  // an SNS graphic → its texts and flat shapes, for rebuilding it as editable layers (Claude vision)
  async icAnalyzeDesign(p, env) {
    if (!env.GEMINI_API_KEY && !env.ANTHROPIC_API_KEY) throw new Error('画像からの再現機能はまだ設定されていません（管理者がAPIキーを登録すると使えます）');
    const m = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(p.image || ''));
    if (!m) throw new Error('画像が読めません');
    if (m[2].length > 4_500_000) throw new Error('画像が大きすぎます');
    const W = Math.round(+p.width) || 0, H = Math.round(+p.height) || 0;
    // Gemini (free tier) when its key is registered, otherwise Claude
    if (env.GEMINI_API_KEY) {
      const raw = await geminiDesign(env, m[1], m[2], W, H), d = normalizeDesign(fromBox2d(raw, W, H));
      if (!d.elements.some(e => e.w > 1 && e.h > 1)) throw new Error('解析結果を読み取れませんでした（返答：' + JSON.stringify(raw).slice(0, 300) + '）');
      return d;
    }
    const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
    const res = await client.beta.messages.create({
      model: 'claude-opus-5-5',
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'high', format: { type: 'json_schema', schema: DESIGN_SCHEMA } },
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } },
        { type: 'text', text: DESIGN_PROMPT.replace('{W}', W).replace('{H}', H) },
      ] }],
    });
    if (res.stop_reason === 'refusal') throw new Error('この画像は解析できませんでした');
    if (res.stop_reason === 'max_tokens') throw new Error('要素が多すぎて解析しきれませんでした');
    const text = res.content.find(b => b.type === 'text')?.text || '';
    try { return normalizeDesign(JSON.parse(text)); } catch (e) { throw new Error('解析結果を読み取れませんでした'); }
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

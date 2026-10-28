// Función serverless para Vercel: puente de solo lectura entre AnkiCollab y ClinQ.
// Variables de entorno opcionales: ALLOWED_ORIGIN (orígenes separados por coma),
// ANKICOLLAB_API (por defecto https://plugin.ankicollab.com), ANKICOLLAB_TOKEN
// (token de una cuenta de AnkiCollab; si no se define, cada navegador puede enviar
// el suyo en el campo "token" y nunca se guarda en el servidor).
const zlib = require('zlib');

const BASE = (process.env.ANKICOLLAB_API || 'https://plugin.ankicollab.com').replace(/\/+$/, '');
const MAX_KEYS = 8;
const LIMIT = 30;
const WINDOW_MS = 60000;
const hits = new Map();
const EPOCH = '2022-12-31 23:59:59';

function cors(req, res) {
  const origins = (process.env.ALLOWED_ORIGIN || 'https://parphelyos.github.io')
    .split(',').map((s) => s.trim()).filter(Boolean);
  const o = req.headers.origin;
  let ok = !o;
  if (o) {
    try {
      const u = new URL(o);
      ok = origins.includes(o) ||
        u.host === req.headers.host ||
        ((u.hostname === 'localhost' || u.hostname === '127.0.0.1') && (u.protocol === 'http:' || u.protocol === 'https:'));
    } catch (e) {}
  }
  if (ok && o) {
    res.setHeader('Access-Control-Allow-Origin', o);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Cache-Control', 'no-store');
  return ok;
}

function validKey(k) {
  if (typeof k !== 'string') return false;
  const parts = k.trim().split('-');
  if (![3, 5, 6].includes(parts.length)) return false;
  return parts.every((p) => /^[A-Za-z]+$/.test(p));
}

function validStamp(v) {
  if (typeof v !== 'string') return false;
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(v)) return false;
  const d = new Date(v.replace(' ', 'T') + 'Z');
  return !isNaN(d.getTime());
}

function utcStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate()) + ' ' +
    p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()) + ':' + p(d.getUTCSeconds());
}

function text(v) {
  return typeof v === 'string' ? v : (v == null ? '' : String(v));
}

function normModel(m) {
  if (!m || typeof m !== 'object') return null;
  const id = text(m.crowdanki_uuid || m.id || m.name).slice(0, 200);
  const name = text(m.name || 'Anki').slice(0, 200);
  if (!id) return null;
  const flds = Array.isArray(m.flds) ? m.flds : [];
  const tmpls = Array.isArray(m.tmpls) ? m.tmpls : [];
  const fields = flds.map((f) => text(f && f.name)).filter(Boolean).slice(0, 80);
  let type = Number(m.type);
  if (!Number.isFinite(type)) type = /cloze/i.test(name) ? 1 : 0;
  return {
    id,
    name,
    type: type === 1 ? 1 : 0,
    fields,
    templates: tmpls.map((t) => ({
      qfmt: text(t && t.qfmt),
      afmt: text(t && t.afmt),
    })).slice(0, 40),
  };
}

function normNote(n) {
  if (!n || typeof n !== 'object') return null;
  const guid = text(n.guid || n.uuid || n.id).slice(0, 300);
  if (!guid) return null;
  const fields = Array.isArray(n.fields) ? n.fields.map(text).slice(0, 80) : [];
  const tags = Array.isArray(n.tags) ? n.tags.map(text).filter(Boolean).slice(0, 60)
    : text(n.tags).split(/\s+/).filter(Boolean).slice(0, 60);
  return {
    guid,
    fields,
    tags,
    model: text(n.note_model_uuid || n.mid || n.model).slice(0, 200),
    flags: Number(n.flags) || 0,
  };
}

function normDeck(d, depth) {
  if (!d || typeof d !== 'object' || depth > 10) return null;
  const notes = Array.isArray(d.notes) ? d.notes : [];
  const models = Array.isArray(d.note_models) ? d.note_models : [];
  const children = Array.isArray(d.children) ? d.children : [];
  return {
    id: text(d.crowdanki_uuid || d.id || d.name).slice(0, 200),
    name: text(d.name || 'AnkiCollab').slice(0, 300),
    desc: text(d.desc).slice(0, 500),
    notes: notes.map(normNote).filter(Boolean).slice(0, 20000),
    models: models.map(normModel).filter(Boolean).slice(0, 100),
    children: children.map((c) => normDeck(c, depth + 1)).filter(Boolean).slice(0, 200),
  };
}

function decodeBody(raw) {
  const t = raw.trim();
  if (!t) return [];
  if (t[0] === '[' || t[0] === '{') return JSON.parse(t);
  const gz = Buffer.from(t, 'base64');
  return JSON.parse(zlib.gunzipSync(gz).toString('utf8'));
}

async function ankiCollab(path, body, token, timeout) {
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
  const auth = token || process.env.ANKICOLLAB_TOKEN;
  if (auth) headers.Authorization = 'Bearer ' + auth;
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeout) : null;
  try {
    return await fetch(BASE + path, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller ? controller.signal : undefined,
    });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

module.exports = async (req, res) => {
  const ok = cors(req, res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido', code: 'method' });
  if (!ok) return res.status(403).json({ error: 'Origen no permitido', code: 'origin' });

  const ip = String(req.headers['x-forwarded-for'] || 'x').split(',')[0].trim();
  const now = Date.now();
  const h = (hits.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  if (h.length >= LIMIT) {
    return res.status(429).json({
      error: 'Demasiadas comprobaciones. Espera un minuto e inténtalo de nuevo.',
      code: 'rate',
    });
  }
  h.push(now);
  hits.set(ip, h);

  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  } catch (e) {
    return res.status(400).json({ error: 'El cuerpo de la solicitud no es JSON válido.', code: 'body' });
  }
  if (!body || typeof body !== 'object') body = {};

  const token = String(body.token || req.headers.authorization || '').replace(/^Bearer\s+/i, '').slice(0, 4096);
  const action = body.action === 'check' ? 'check' : 'sync';

  if (action === 'check') {
    const keys = (Array.isArray(body.keys) ? body.keys : [body.key])
      .map((k) => String(k || '').trim().toLowerCase())
      .filter((k) => k);
    const bad = keys.filter((k) => !validKey(k));
    const good = [...new Set(keys.filter(validKey))].slice(0, MAX_KEYS);
    if (bad.length) {
      return res.status(400).json({
        error: 'La clave debe tener 3, 5 o 6 palabras separadas por guiones (solo letras).',
        code: 'key',
      });
    }
    if (!good.length) return res.status(400).json({ error: 'Falta la clave del mazo.', code: 'key' });
    try {
      const r = await ankiCollab('/CheckDeckAlive', { deck_hashes: good }, token, 20000);
      if (r.status === 401) {
        return res.status(401).json({ error: 'AnkiCollab rechazó la sesión. Este mazo puede ser privado.', code: 'auth' });
      }
      if (!r.ok) {
        return res.status(502).json({ error: 'AnkiCollab no respondió (' + r.status + ').', code: 'upstream' });
      }
      const dead = await r.json().catch(() => []);
      const deadList = Array.isArray(dead) ? dead.map(String) : [];
      return res.status(200).json({
        ok: true,
        alive: good.filter((k) => !deadList.includes(k)),
        dead: good.filter((k) => deadList.includes(k)),
      });
    } catch (e) {
      const timeout = e && (e.name === 'AbortError' || e.name === 'TimeoutError');
      return res.status(timeout ? 504 : 502).json({
        error: timeout ? 'AnkiCollab tardó demasiado en responder.' : 'No se pudo conectar con AnkiCollab.',
        code: timeout ? 'timeout' : 'network',
      });
    }
  }

  const input = Array.isArray(body.decks) ? body.decks : [];
  if (!input.length || input.length > MAX_KEYS) {
    return res.status(400).json({
      error: 'Envía entre 1 y ' + MAX_KEYS + ' mazos para sincronizar.',
      code: 'decks',
    });
  }
  const request = {};
  const requested = [];
  for (const item of input) {
    const key = String((item && (item.key || item.deck)) || '').trim().toLowerCase();
    if (!validKey(key)) {
      return res.status(400).json({
        error: 'Hay una clave de AnkiCollab con formato incorrecto.',
        code: 'key',
      });
    }
    const since = validStamp(item && item.timestamp) ? item.timestamp : EPOCH;
    request[key] = { timestamp: since, deckId: 0, optional_tags: {}, personal_tags: [] };
    requested.push(key);
  }

  const syncedAt = utcStamp();
  let r;
  try {
    r = await ankiCollab('/pullChanges', request, token, 50000);
  } catch (e) {
    const timeout = e && (e.name === 'AbortError' || e.name === 'TimeoutError');
    return res.status(timeout ? 504 : 502).json({
      error: timeout ? 'AnkiCollab tardó demasiado en responder. Prueba otra vez.' : 'No se pudo conectar con AnkiCollab.',
      code: timeout ? 'timeout' : 'network',
    });
  }

  if (r.status === 401) {
    return res.status(401).json({
      error: 'AnkiCollab rechazó la sesión. Si el mazo es privado, añade tu token de AnkiCollab.',
      code: 'auth',
    });
  }
  if (!r.ok) {
    return res.status(502).json({ error: 'AnkiCollab respondió con un error (' + r.status + ').', code: 'upstream' });
  }

  let payload;
  try {
    payload = decodeBody(await r.text());
  } catch (e) {
    return res.status(502).json({ error: 'La respuesta de AnkiCollab no se pudo leer.', code: 'decode' });
  }
  if (payload && !Array.isArray(payload) && typeof payload === 'object') payload = [payload];
  if (!Array.isArray(payload)) payload = [];

  const decks = [];
  for (const sub of payload) {
    if (!sub || typeof sub !== 'object' || !sub.deck) continue;
    let key = text(sub.deck_hash).trim().toLowerCase();
    if (!key && requested.length === 1) key = requested[0];
    const deck = normDeck(sub.deck, 0);
    if (!deck) continue;
    decks.push({
      key,
      deckHash: text(sub.deck_hash || key),
      name: deck.name,
      lastModified: text(sub.deck_last_modified) || null,
      deleted: Array.isArray(sub.deleted_notes) ? sub.deleted_notes.map(text).filter(Boolean).slice(0, 5000) : [],
      optionalTags: sub.optional_tags && typeof sub.optional_tags === 'object' ? sub.optional_tags : {},
      deck,
    });
  }

  // AnkiCollab omits decks that have not changed since the given timestamp.
  const returned = new Set(decks.map((d) => d.key));
  return res.status(200).json({
    ok: true,
    syncedAt,
    requested,
    unchanged: requested.filter((k) => !returned.has(k)),
    decks,
  });
};

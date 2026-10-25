// Función serverless para Vercel: recibe texto de un PDF y devuelve casos/preguntas en JSON.
// Variables de entorno en Vercel: GEMINI_API_KEY (obligatoria), ALLOWED_ORIGIN (opcional, separadas por coma), GEMINI_MODEL (opcional).
const MAX_CHARS = 30000, LIMIT = 20, WINDOW_MS = 60000, hits = new Map();

const SYS = 'Eres un asistente que prepara preguntas de opción múltiple para estudiantes de medicina. Respondes SOLO con JSON válido.';
const FORMAT = 'Formato: {"questions":[{"stem":"enunciado","options":["texto A","texto B","texto C","texto D","texto E"],"answer":"B","explanation":"explicación breve","page":14}]}. "options" lleva solo el texto, sin letras. "page" es el número del marcador [[PÁGINA n]] donde está la información.';

function prompt(b) {
  const text = String(b.text || '').slice(0, MAX_CHARS);
  if (b.mode === 'fidelity') {
    return `Extrae TODAS las preguntas o casos clínicos con opciones que aparezcan en el texto, tal cual están escritos: no inventes, no reformules el enunciado ni las opciones y no omitas ninguno. Si el texto trae la respuesta correcta o la explicación, inclúyelas; si no, deja "answer" y "explanation" vacíos. ${FORMAT}\n\nTEXTO:\n${text}`;
  }
  const n = Math.min(Math.max(parseInt(b.count) || 5, 1), 20);
  const style = b.style === 'direct' ? 'preguntas directas y concisas sobre los conceptos del texto' : 'viñetas clínicas estilo USMLE Step 2 CK (edad, sexo, motivo de consulta, hallazgos, laboratorio) con una pregunta final';
  const avoid = b.avoid ? `\nNo repitas ni parafrasees esta pregunta: ${String(b.avoid).slice(0, 300)}` : '';
  return `Crea exactamente ${n} preguntas de opción múltiple con 5 opciones (A–E) y una sola correcta, como ${style}. Usa ÚNICAMENTE información contenida en el texto; no inventes datos. Los distractores deben ser plausibles. La explicación indica por qué la correcta lo es y por qué falla alguna incorrecta.${avoid} ${FORMAT}\n\nTEXTO:\n${text}`;
}

module.exports = async (req, res) => {
  const origins = (process.env.ALLOWED_ORIGIN || 'https://parphelyos.github.io').split(',').map((s) => s.trim());
  const o = req.headers.origin;
  let ok = !o;
  if (o) { try { ok = origins.includes(o) || new URL(o).host === req.headers.host; } catch (e) {} }
  if (ok && o) { res.setHeader('Access-Control-Allow-Origin', o); res.setHeader('Vary', 'Origin'); }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });
  if (!ok) return res.status(403).json({ error: 'Origen no permitido' });

  const ip = String(req.headers['x-forwarded-for'] || 'x').split(',')[0].trim(), now = Date.now();
  const h = (hits.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  if (h.length >= LIMIT) return res.status(429).json({ error: 'Demasiadas solicitudes. Espera un minuto e inténtalo de nuevo.' });
  h.push(now); hits.set(ip, h);

  const key = process.env.GEMINI_API_KEY;
  if (!key) return res.status(500).json({ error: 'El servidor no tiene configurada la clave de IA.' });
  const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  if (!b.text || String(b.text).length < 200) return res.status(400).json({ error: 'Texto insuficiente.' });

  try {
    const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYS }] },
        contents: [{ role: 'user', parts: [{ text: prompt(b) }] }],
        generationConfig: { responseMimeType: 'application/json', temperature: b.mode === 'fidelity' ? 0.1 : 0.5 },
      }),
    });
    if (r.status === 429) return res.status(429).json({ error: 'Se alcanzó el límite del servicio de IA. Inténtalo en un minuto.' });
    if (!r.ok) return res.status(502).json({ error: 'El servicio de IA no respondió (' + r.status + ').' });
    const j = await r.json();
    const t = ((((j.candidates || [])[0] || {}).content || {}).parts || []).map((p) => p.text || '').join('').replace(/^```json|```$/g, '').trim();
    const parsed = JSON.parse(t);
    const questions = Array.isArray(parsed) ? parsed : parsed.questions;
    return res.status(200).json({ questions: Array.isArray(questions) ? questions : [] });
  } catch (e) {
    return res.status(502).json({ error: 'No se pudo procesar la respuesta de la IA. Inténtalo de nuevo.' });
  }
};

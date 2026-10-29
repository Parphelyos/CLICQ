/* =====================================================================
   NativeOCR v1.0 — extracción de texto LOCAL (sin IA generativa, sin API, sin servidores)
   Lee cualquier archivo en el navegador:
     · Texto plano / CSV / JSON / XML / SRT…  → se decodifica (UTF-8, UTF-16 o Windows-1252)
     · HTML, RTF, EPUB, ODT/ODP/ODS            → se parsea el marcado
     · PDF                                     → capa de texto (pdf.js) + OCR (Tesseract) de la página
                                                 renderizada si es escaneada o tiene imágenes/capturas
     · DOCX / PPTX / XLSX                      → XML interno (incluye cuadros de texto, notas,
                                                 encabezados) + OCR de las imágenes incrustadas
     · Imágenes (PNG, JPG, WEBP, GIF, BMP…)    → OCR
     · ZIP                                     → se abre y se procesa cada archivo
     · DOC/PPT antiguos y binarios desconocidos→ lectura básica de cadenas de texto
   El tipo se detecta por los primeros bytes (no solo por la extensión).
   ===================================================================== */
(function () {
  'use strict';
  if (window.NativeOCR) return;

  const CDN = {
    pdfjs: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js',
    pdfWorker: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js',
    tesseract: 'https://cdnjs.cloudflare.com/ajax/libs/tesseract.js/5.1.1/tesseract.min.js',
    jszip: 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js',
    xlsx: 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js'
  };

  const cfg = {
    langs: 'spa+eng',          // idiomas del OCR
    workers: Math.max(1, Math.min(3, Math.floor((navigator.hardwareConcurrency || 2) / 2))),
    minConf: 50,               // confianza mínima por línea (0-100) para aceptar texto del OCR
    maxImagesPerDoc: 120,      // tope de imágenes incrustadas a leer por documento
    minImagePx: 60,            // ignora imágenes más pequeñas (iconos, viñetas)
    ocrImages: true,           // leer también el texto dentro de imágenes/capturas
    // Para trabajar 100 % sin conexión, aloja estos archivos y pon aquí sus rutas:
    workerPath: null, corePath: null, langPath: null, gzip: null,
    urls: CDN
  };

  let cancelFlag = false;
  const $ = (id) => document.getElementById(id);

  /* ---------- utilidades ---------- */
  function load(url, globalName) {
    if (typeof window.loadScript === 'function') return window.loadScript(url, globalName);
    if (window[globalName]) return Promise.resolve(window[globalName]);
    window.__noScripts = window.__noScripts || {};
    if (window.__noScripts[globalName]) return window.__noScripts[globalName];
    return (window.__noScripts[globalName] = new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = url;
      s.onload = () => (window[globalName] ? res(window[globalName]) : rej(new Error('No se pudo iniciar ' + globalName)));
      s.onerror = () => rej(new Error('No se pudo cargar una biblioteca necesaria. Comprueba tu conexión.'));
      document.head.appendChild(s);
    }));
  }

  async function mapLimit(arr, limit, fn) {
    const res = new Array(arr.length);
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(limit, arr.length) }, async () => {
      for (;;) {
        const k = i++;
        if (k >= arr.length) return;
        res[k] = await fn(arr[k], k);
      }
    }));
    return res;
  }

  const xmlDoc = (s) => new DOMParser().parseFromString(s, 'application/xml');
  const norm = (s) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

  function clean(t) {
    return String(t || '').replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{4,}/g, '\n\n\n').trim();
  }

  const _w1252 = typeof TextDecoder !== 'undefined' ? new TextDecoder('windows-1252') : null;
  function decodeText(u8) {
    if (u8[0] === 0xEF && u8[1] === 0xBB && u8[2] === 0xBF) u8 = u8.subarray(3);
    else if (u8[0] === 0xFF && u8[1] === 0xFE) return new TextDecoder('utf-16le').decode(u8.subarray(2));
    else if (u8[0] === 0xFE && u8[1] === 0xFF) return new TextDecoder('utf-16be').decode(u8.subarray(2));
    try { return new TextDecoder('utf-8', { fatal: true }).decode(u8); } catch (e) { /* no es UTF-8 */ }
    return _w1252.decode(u8);
  }
  function looksText(u8) {
    const n = Math.min(u8.length, 8000);
    if (!n) return true;
    if ((u8[0] === 0xFF && u8[1] === 0xFE) || (u8[0] === 0xFE && u8[1] === 0xFF)) return true;
    let bad = 0;
    for (let i = 0; i < n; i++) { const b = u8[i]; if (b === 0 || (b < 9) || (b > 13 && b < 32 && b !== 27)) bad++; }
    return bad / n < 0.02;
  }

  /* ---------- detección de tipo (por bytes, luego por extensión) ---------- */
  const EXTMAP = {
    txt: 'text', md: 'text', markdown: 'text', csv: 'text', tsv: 'text', json: 'text', jsonl: 'text', ndjson: 'text', log: 'text',
    xml: 'text', yaml: 'text', yml: 'text', ini: 'text', srt: 'text', vtt: 'text', tex: 'text', bib: 'text', rst: 'text', anki: 'text',
    html: 'html', htm: 'html', xhtml: 'html', rtf: 'rtf', pdf: 'pdf',
    docx: 'docx', docm: 'docx', dotx: 'docx', pptx: 'pptx', pptm: 'pptx', ppsx: 'pptx', potx: 'pptx',
    xlsx: 'xlsx', xlsm: 'xlsx', xls: 'xls', ods: 'ods', odt: 'odf', odp: 'odf', epub: 'epub', zip: 'zip',
    png: 'image', jpg: 'image', jpeg: 'image', jpe: 'image', gif: 'image', webp: 'image', bmp: 'image', avif: 'image', svg: 'svg',
    doc: 'legacy', dot: 'legacy', ppt: 'legacy', pps: 'legacy'
  };
  function magic(a) {
    const s4 = String.fromCharCode(a[0] || 0, a[1] || 0, a[2] || 0, a[3] || 0);
    if (s4 === '%PDF') return 'pdf';
    if (a[0] === 0x89 && s4.slice(1) === 'PNG') return 'image';
    if (a[0] === 0xFF && a[1] === 0xD8 && a[2] === 0xFF) return 'image';
    if (s4 === 'GIF8') return 'image';
    if (s4 === 'RIFF' && String.fromCharCode(a[8] || 0, a[9] || 0, a[10] || 0, a[11] || 0) === 'WEBP') return 'image';
    if (a[0] === 0x42 && a[1] === 0x4D) return 'image-bmp?';
    if (a[0] === 0x50 && a[1] === 0x4B && (a[2] === 3 || a[2] === 5 || a[2] === 7)) return 'zip';
    if (s4 === '{\\rt') return 'rtf';
    if (a[0] === 0xD0 && a[1] === 0xCF && a[2] === 0x11 && a[3] === 0xE0) return 'ole';
    if (String.fromCharCode(a[4] || 0, a[5] || 0, a[6] || 0, a[7] || 0) === 'ftyp') return 'image';
    return '';
  }
  async function detect(file) {
    const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    const byExt = EXTMAP[ext];
    let m = magic(head);
    if (m === 'image-bmp?') m = byExt === 'image' ? 'image' : '';
    if (m === 'pdf') return 'pdf';
    if (m === 'image') return byExt === 'svg' ? 'svg' : 'image';
    if (m === 'rtf') return 'rtf';
    if (m === 'ole') return byExt === 'xls' ? 'xls' : 'legacy';
    if (m === 'zip') return ['docx', 'pptx', 'xlsx', 'ods', 'odf', 'epub'].includes(byExt) ? byExt : 'zip';
    if (byExt === 'svg' || byExt === 'html' || byExt === 'text') return byExt;
    if (byExt && looksText(head) && ['docx', 'pptx', 'xlsx', 'pdf', 'image'].indexOf(byExt) < 0) return byExt;
    if (byExt && !looksText(head)) return byExt;
    return looksText(head) ? 'text' : 'binary';
  }
  async function zipKind(file) {
    const Z = await load(cfg.urls.jszip, 'JSZip');
    const zip = await Z.loadAsync(file);
    const n = Object.keys(zip.files);
    if (n.includes('word/document.xml')) return 'docx';
    if (n.includes('ppt/presentation.xml')) return 'pptx';
    if (n.includes('xl/workbook.xml')) return 'xlsx';
    if (zip.file('mimetype')) {
      const mt = (await zip.file('mimetype').async('string')).trim();
      if (/opendocument\.spreadsheet/.test(mt)) return 'ods';
      if (/opendocument/.test(mt)) return 'odf';
      if (/epub/.test(mt)) return 'epub';
    }
    return 'zip';
  }

  /* ---------- OCR (Tesseract.js, local) ---------- */
  let poolP = null, users = 0, idleTimer = null;
  function acquire() { users++; clearTimeout(idleTimer); }
  function release() {
    users = Math.max(0, users - 1);
    if (!users) {
      idleTimer = setTimeout(async () => {
        if (users || !poolP) return;
        const p = poolP; poolP = null;
        try { (await p).terminate(); } catch (e) { /* nada */ }
      }, 45000);
    }
  }
  function ensurePool(say) {
    if (poolP) return poolP;
    say && say('Preparando OCR local (la primera vez descarga el idioma, ~15 MB)…');
    poolP = (async () => {
      const T = await load(cfg.urls.tesseract, 'Tesseract');
      const sch = T.createScheduler();
      const opts = {};
      if (cfg.workerPath) opts.workerPath = cfg.workerPath;
      if (cfg.corePath) opts.corePath = cfg.corePath;
      if (cfg.langPath) opts.langPath = cfg.langPath;
      if (cfg.gzip === false) opts.gzip = false;
      for (let i = 0; i < cfg.workers; i++) {
        const w = await T.createWorker(cfg.langs, 1, opts);
        await w.setParameters({ preserve_interword_spaces: '1', user_defined_dpi: '300' });
        sch.addWorker(w);
      }
      return sch;
    })().catch((e) => { poolP = null; throw new Error('No se pudo iniciar el OCR: ' + (e.message || e)); });
    return poolP;
  }

  // Escala de grises + estiramiento de contraste + inversión si el fondo es oscuro.
  function prepCanvas(src) {
    const w0 = src.naturalWidth || src.videoWidth || src.width, h0 = src.naturalHeight || src.videoHeight || src.height;
    const maxSide = Math.max(w0, h0);
    let k = 1;
    if (maxSide < 1600) k = Math.min(3, 1800 / maxSide); else if (maxSide > 3400) k = 3400 / maxSide;
    const cv = document.createElement('canvas');
    cv.width = Math.max(1, Math.round(w0 * k)); cv.height = Math.max(1, Math.round(h0 * k));
    const g = cv.getContext('2d', { willReadFrequently: true });
    g.fillStyle = '#fff'; g.fillRect(0, 0, cv.width, cv.height);
    g.imageSmoothingQuality = 'high';
    g.drawImage(src, 0, 0, cv.width, cv.height);
    const im = g.getImageData(0, 0, cv.width, cv.height), d = im.data, n = d.length / 4;
    const hist = new Uint32Array(256); let sum = 0;
    for (let i = 0, p = 0; i < n; i++, p += 4) {
      const y = (d[p] * 299 + d[p + 1] * 587 + d[p + 2] * 114) / 1000 | 0;
      d[p] = y; hist[y]++; sum += y;
    }
    const mean = sum / n;
    // Estiramiento de contraste solo si la imagen es de bajo contraste (un 95 % de página blanca no debe romperlo).
    let acc = 0, lo = 0, hi = 255;
    for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= n * 0.0002) { lo = v; break; } }
    acc = 0;
    for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc >= n * 0.02) { hi = v; break; } }
    const stretch = (hi - lo) >= 40 && (hi - lo) < 200, span = Math.max(1, hi - lo), inv = mean < 100;
    for (let p = 0; p < d.length; p += 4) {
      let v = d[p];
      if (stretch) { v = (v - lo) * 255 / span; v = v < 0 ? 0 : v > 255 ? 255 : v; }
      if (inv) v = 255 - v;
      d[p] = d[p + 1] = d[p + 2] = v; d[p + 3] = 255;
    }
    g.putImageData(im, 0, 0);
    return cv;
  }
  function linesFrom(data) {
    const out = [];
    const keep = (t) => {
      t = String(t || '').replace(/\s+/g, ' ').trim();
      if (!t) return null;
      const alnum = (t.match(/[\p{L}\p{N}]/gu) || []).length;
      if (alnum < 2 || alnum / t.length < 0.45) return null;
      return t;
    };
    if (Array.isArray(data.lines) && data.lines.length) {
      for (const l of data.lines) {
        if ((l.confidence == null ? 100 : l.confidence) < cfg.minConf) continue;
        const t = keep(l.text); if (t) out.push(t);
      }
    } else {
      for (const s of String(data.text || '').split(/\n+/)) { const t = keep(s); if (t) out.push(t); }
    }
    return out;
  }
  async function ocrSource(src, ctx) {
    const sch = await ensurePool(ctx.say);
    const cv = prepCanvas(src);
    try { const { data } = await sch.addJob('recognize', cv); return linesFrom(data); }
    finally { cv.width = cv.height = 0; }
  }
  // Devuelve solo las líneas del OCR que NO están ya en el texto del documento.
  function extras(baseText, lines) {
    const blob = ' ' + norm(baseText) + ' ';
    const out = [];
    for (const l of lines) {
      const n = norm(l);
      if (n.length < 3) continue;
      if (blob.includes(' ' + n + ' ') || blob.includes(n)) continue;
      const sig = n.split(' ').filter((w) => w.length > 2);
      if (sig.length) {
        const hit = sig.filter((w) => blob.includes(' ' + w + ' ')).length;
        if (hit / sig.length >= 0.85) continue;
      }
      out.push(l);
    }
    return out;
  }
  async function decodeBlob(blob) {
    try { return await createImageBitmap(blob); }
    catch (e) {
      return await new Promise((res, rej) => {
        const u = URL.createObjectURL(blob), im = new Image();
        im.onload = () => res(im);
        im.onerror = () => rej(new Error('Formato de imagen no compatible con el navegador (convierte TIFF/HEIC a PNG o JPG).'));
        im.src = u;
      });
    }
  }
  const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', jpe: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', avif: 'image/avif', svg: 'image/svg+xml' };
  function hashBytes(u8) {
    let h = 2166136261 ^ u8.length; const step = Math.max(1, Math.floor(u8.length / 4096));
    for (let i = 0; i < u8.length; i += step) { h ^= u8[i]; h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  // OCR de una imagen incrustada (dentro de docx/pptx/xlsx/odf). Ignora iconos y logos repetidos.
  async function ocrEmbedded(zip, path, ctx) {
    if (cancelFlag || !ctx.ocrImages) return [];
    const ext = path.split('.').pop().toLowerCase();
    if (!MIME[ext] || ext === 'svg') return [];
    if (ctx.stats.ocrImages >= cfg.maxImagesPerDoc) return [];
    const f = zip.file(path);
    if (!f) return [];
    const u8 = await f.async('uint8array');
    const key = hashBytes(u8), seen = ctx.cache.get(key);
    if (seen) { seen.n++; return seen.n <= 2 ? seen.lines : []; }
    let bmp;
    try { bmp = await decodeBlob(new Blob([u8], { type: MIME[ext] })); } catch (e) { return []; }
    const w = bmp.naturalWidth || bmp.width, h = bmp.naturalHeight || bmp.height;
    if (Math.min(w, h) < cfg.minImagePx || w * h < 6000) { bmp.close && bmp.close(); ctx.cache.set(key, { n: 99, lines: [] }); return []; }
    ctx.stats.ocrImages++;
    ctx.say('OCR de imagen incrustada ' + ctx.stats.ocrImages + '…');
    const lines = await ocrSource(bmp, ctx);
    bmp.close && bmp.close();
    ctx.cache.set(key, { n: 1, lines });
    return lines;
  }

  /* ---------- PDF ---------- */
  function layerText(tc) {
    const items = tc.items.filter((it) => it.str && it.str.trim())
      .map((it) => ({ x: it.transform[4], y: it.transform[5], h: Math.abs(it.height || it.transform[3]) || 10, w: it.width || 0, s: it.str }));
    items.sort((a, b) => b.y - a.y || a.x - b.x);
    const lines = [];
    for (const it of items) {
      const L = lines.find((l) => Math.abs(l.y - it.y) <= Math.max(2, l.h * 0.45));
      if (L) L.items.push(it); else lines.push({ y: it.y, h: it.h, items: [it] });
    }
    lines.sort((a, b) => b.y - a.y);
    return lines.map((l) => {
      l.items.sort((a, b) => a.x - b.x);
      let s = '', px = null;
      for (const it of l.items) {
        if (px !== null && it.x - px > it.h * 0.15 && !/\s$/.test(s) && !/^\s/.test(it.s)) s += ' ';
        s += it.s; px = it.x + it.w;
      }
      return s.replace(/\s+/g, ' ').trim();
    }).filter(Boolean).join('\n');
  }
  async function pdfExtract(file, ctx) {
    const lib = await load(cfg.urls.pdfjs, 'pdfjsLib');
    lib.GlobalWorkerOptions.workerSrc = cfg.urls.pdfWorker;
    const pdf = await lib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
    const N = pdf.numPages, pages = new Array(N);
    let done = 0;
    await mapLimit([...Array(N).keys()], cfg.workers + 1, async (i) => {
      if (cancelFlag) return;
      const page = await pdf.getPage(i + 1);
      let layer = '';
      try { layer = layerText(await page.getTextContent()); } catch (e) { /* sin capa de texto */ }
      const scanned = layer.replace(/\s/g, '').length < 40;
      let hasImg = false;
      if (ctx.ocrImages && !scanned) {
        try {
          const ops = await page.getOperatorList(), O = lib.OPS;
          const set = new Set([O.paintImageXObject, O.paintInlineImageXObject, O.paintImageMaskXObject, O.paintJpegXObject].filter((x) => x !== undefined));
          hasImg = ops.fnArray.some((f) => set.has(f));
        } catch (e) { hasImg = true; }
      }
      let extra = [];
      if (scanned || hasImg) {
        const v1 = page.getViewport({ scale: 1 });
        const scale = Math.min(5, Math.max(1.5, 2600 / Math.max(v1.width, v1.height)));
        const vp = page.getViewport({ scale });
        const cv = document.createElement('canvas');
        cv.width = Math.round(vp.width); cv.height = Math.round(vp.height);
        const g = cv.getContext('2d');
        g.fillStyle = '#fff'; g.fillRect(0, 0, cv.width, cv.height);
        await page.render({ canvasContext: g, viewport: vp }).promise;
        const lines = await ocrSource(cv, ctx);
        cv.width = cv.height = 0;
        extra = extras(layer, lines);
        ctx.stats.ocrPages++;
      }
      pages[i] = layer + (extra.length ? (layer ? '\n' : '') + extra.join('\n') : '');
      ctx.say('Leyendo ' + file.name + ': página ' + (++done) + ' de ' + N + (scanned || hasImg ? ' (con OCR)' : '') + '…');
      page.cleanup();
    });
    return pages.map((p) => p || '').join('\n\n');
  }

  /* ---------- Imágenes y SVG ---------- */
  async function imageExtract(file, ctx) {
    const bmp = await decodeBlob(file);
    ctx.say('OCR de ' + file.name + '…');
    const lines = await ocrSource(bmp, ctx);
    bmp.close && bmp.close();
    ctx.stats.ocrImages++;
    return lines.join('\n');
  }
  async function svgExtract(file, ctx) {
    const s = await file.text();
    const d = xmlDoc(s);
    const t = [...d.getElementsByTagName('*')].filter((e) => /^(title|desc|text)$/.test(e.localName))
      .map((e) => e.textContent.replace(/\s+/g, ' ').trim()).filter(Boolean);
    if (t.length) return t.join('\n');
    const bmp = await decodeBlob(new Blob([s], { type: 'image/svg+xml' }));
    return (await ocrSource(bmp, ctx)).join('\n');
  }

  /* ---------- Office Open XML / ODF ---------- */
  function resolvePath(base, target) {
    if (target.startsWith('/')) return target.slice(1);
    const parts = base.split('/').slice(0, -1);
    for (const seg of target.split('/')) { if (seg === '..') parts.pop(); else if (seg && seg !== '.') parts.push(seg); }
    return parts.join('/');
  }
  async function relsOf(zip, path) {
    const f = zip.file(path.replace(/([^/]+)$/, '_rels/$1.rels'));
    if (!f) return [];
    const d = xmlDoc(await f.async('string'));
    return [...d.getElementsByTagName('Relationship')]
      .filter((r) => r.getAttribute('TargetMode') !== 'External')
      .map((r) => ({ type: r.getAttribute('Type') || '', path: resolvePath(path, r.getAttribute('Target') || '') }));
  }
  function stripFallback(d) { [...d.getElementsByTagName('mc:Fallback')].forEach((e) => e.parentNode && e.parentNode.removeChild(e)); }
  const num = (s) => +(s.match(/(\d+)\.xml$/) || [0, 0])[1];

  function wordLines(root) {
    const lines = [];
    const walkP = (p, line) => {
      for (const c of p.childNodes) {
        if (c.nodeType !== 1) continue;
        const t = c.nodeName;
        if (t === 'w:t') line.s += c.textContent;
        else if (t === 'w:tab') line.s += '\t';
        else if (t === 'w:br' || t === 'w:cr') line.s += '\n';
        else if (t === 'w:p') { const l2 = { s: '' }; lines.push(l2); walkP(c, l2); }
        else if (t === 'mc:Fallback' || t === 'w:instrText' || t === 'w:delText') continue;
        else walkP(c, line);
      }
    };
    const visit = (n) => {
      for (const c of n.childNodes) {
        if (c.nodeType !== 1) continue;
        if (c.nodeName === 'w:p') { const l = { s: '' }; lines.push(l); walkP(c, l); }
        else if (c.nodeName === 'w:tr') {
          const cells = [...c.childNodes].filter((x) => x.nodeName === 'w:tc').map((tc) => {
            const sub = wordLines(tc); return sub.join(' ').trim();
          });
          lines.push({ s: cells.join(' | ') });
        }
        else if (c.nodeName === 'mc:Fallback') continue;
        else visit(c);
      }
    };
    visit(root);
    return lines.map((l) => l.s.trim());
  }
  async function docxExtract(file, ctx) {
    const Z = await load(cfg.urls.jszip, 'JSZip');
    const zip = await Z.loadAsync(await file.arrayBuffer());
    const names = Object.keys(zip.files);
    const parts = ['word/document.xml']
      .concat(names.filter((n) => /^word\/(header|footer)\d*\.xml$/.test(n)))
      .concat(['word/footnotes.xml', 'word/endnotes.xml', 'word/comments.xml'].filter((n) => zip.file(n)));
    let body = '';
    for (const p of parts) {
      const f = zip.file(p); if (!f) continue;
      const d = xmlDoc(await f.async('string'));
      const t = wordLines(d.documentElement).filter(Boolean).join('\n');
      if (t) body += (body ? '\n\n' : '') + t;
    }
    const imgs = names.filter((n) => /^word\/media\//.test(n));
    let extra = [];
    for (const m of imgs) { if (cancelFlag) break; extra = extra.concat(await ocrEmbedded(zip, m, ctx)); }
    extra = extras(body, extra);
    return body + (extra.length ? '\n\n' + extra.join('\n') : '');
  }
  function drawingLines(d) {
    stripFallback(d);
    const out = [];
    for (const p of d.getElementsByTagName('a:p')) {
      let s = '';
      (function w(n) {
        for (const c of n.childNodes) {
          if (c.nodeType !== 1) continue;
          if (c.nodeName === 'a:t') s += c.textContent; else if (c.nodeName === 'a:br') s += '\n'; else w(c);
        }
      })(p);
      s = s.trim(); if (s) out.push(s);
    }
    return out;
  }
  async function pptxExtract(file, ctx) {
    const Z = await load(cfg.urls.jszip, 'JSZip');
    const zip = await Z.loadAsync(await file.arrayBuffer());
    const slides = Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => num(a) - num(b));
    const out = [];
    let k = 0;
    for (const sp of slides) {
      if (cancelFlag) break;
      ctx.say('Leyendo ' + file.name + ': diapositiva ' + (++k) + ' de ' + slides.length + '…');
      const text = drawingLines(xmlDoc(await zip.file(sp).async('string'))).join('\n');
      const rels = await relsOf(zip, sp);
      let notes = '';
      const nr = rels.find((r) => /notesSlide$/.test(r.type));
      if (nr && zip.file(nr.path)) notes = drawingLines(xmlDoc(await zip.file(nr.path).async('string'))).join('\n');
      let extra = [];
      for (const r of rels.filter((r) => /\/image$/.test(r.type))) extra = extra.concat(await ocrEmbedded(zip, r.path, ctx));
      extra = extras(text + '\n' + notes, extra);
      out.push([text, notes, extra.join('\n')].filter(Boolean).join('\n'));
    }
    return out.join('\n\n');
  }
  async function sheetExtract(file, ctx, kind) {
    const XLSX = await load(cfg.urls.xlsx, 'XLSX');
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type: 'array' });
    let text = wb.SheetNames.map((n) => '\n' + n + '\n' + XLSX.utils.sheet_to_csv(wb.Sheets[n])).join('\n\n').trim();
    if (kind !== 'xls' && ctx.ocrImages) {
      try {
        const Z = await load(cfg.urls.jszip, 'JSZip');
        const zip = await Z.loadAsync(buf);
        let extra = [];
        for (const m of Object.keys(zip.files).filter((n) => /^(xl\/media|Pictures)\//.test(n))) extra = extra.concat(await ocrEmbedded(zip, m, ctx));
        extra = extras(text, extra);
        if (extra.length) text += '\n\n' + extra.join('\n');
      } catch (e) { /* sin imágenes */ }
    }
    return text;
  }
  async function odfExtract(file, ctx) {
    const Z = await load(cfg.urls.jszip, 'JSZip');
    const zip = await Z.loadAsync(await file.arrayBuffer());
    const d = xmlDoc(await zip.file('content.xml').async('string'));
    const para = (p) => {
      let s = '';
      (function w(n) {
        for (const c of n.childNodes) {
          if (c.nodeType === 3) { s += c.nodeValue; continue; }
          if (c.nodeType !== 1) continue;
          const t = c.nodeName;
          if (t === 'text:s') s += ' '.repeat(+c.getAttribute('text:c') || 1);
          else if (t === 'text:tab') s += '\t';
          else if (t === 'text:line-break') s += '\n';
          else if (t === 'text:p' || t === 'text:h') continue;
          else w(c);
        }
      })(p);
      return s.trim();
    };
    const all = [...d.getElementsByTagName('*')].filter((e) => e.nodeName === 'text:p' || e.nodeName === 'text:h');
    const body = all.map(para).filter(Boolean).join('\n');
    let extra = [];
    for (const m of Object.keys(zip.files).filter((n) => /^Pictures\//.test(n))) extra = extra.concat(await ocrEmbedded(zip, m, ctx));
    extra = extras(body, extra);
    return body + (extra.length ? '\n\n' + extra.join('\n') : '');
  }
  function htmlToText(html) {
    const d = new DOMParser().parseFromString(html, 'text/html');
    d.querySelectorAll('script,style,noscript,head').forEach((e) => e.remove());
    d.querySelectorAll('br').forEach((b) => b.replaceWith('\n'));
    d.querySelectorAll('img[alt]').forEach((i) => { if (i.alt) i.replaceWith(' ' + i.alt + ' '); });
    d.querySelectorAll('p,div,li,tr,h1,h2,h3,h4,h5,h6,section,article,table,blockquote,pre,ul,ol').forEach((e) => e.append('\n'));
    d.querySelectorAll('td,th').forEach((e) => e.append(' | '));
    return (d.body ? d.body.textContent : d.documentElement.textContent).replace(/[ \t]+/g, ' ');
  }
  async function epubExtract(file) {
    const Z = await load(cfg.urls.jszip, 'JSZip');
    const zip = await Z.loadAsync(await file.arrayBuffer());
    let order = [];
    try {
      const c = xmlDoc(await zip.file('META-INF/container.xml').async('string'));
      const opfPath = c.getElementsByTagName('rootfile')[0].getAttribute('full-path');
      const opf = xmlDoc(await zip.file(opfPath).async('string'));
      const man = {};
      for (const it of opf.getElementsByTagName('item')) man[it.getAttribute('id')] = resolvePath(opfPath, decodeURIComponent(it.getAttribute('href')));
      for (const r of opf.getElementsByTagName('itemref')) { const p = man[r.getAttribute('idref')]; if (p && zip.file(p)) order.push(p); }
    } catch (e) { /* usa el orden por nombre */ }
    if (!order.length) order = Object.keys(zip.files).filter((n) => /\.(x?html?)$/i.test(n)).sort();
    const out = [];
    for (const p of order) { const t = htmlToText(await zip.file(p).async('string')).trim(); if (t) out.push(t); }
    return out.join('\n\n');
  }

  /* ---------- RTF, binarios y ZIP genéricos ---------- */
  function rtfToText(s) {
    const SKIP = new Set(['fonttbl', 'colortbl', 'stylesheet', 'info', 'pict', 'header', 'footer', 'headerl', 'headerr', 'footerl', 'footerr', 'generator', 'themedata', 'colorschememapping', 'latentstyles', 'datastore', 'xmlnstbl', 'listtable', 'listoverridetable', 'rsidtbl', 'private', 'object', 'fldinst', 'revtbl']);
    let out = '', i = 0, skip = false, uc = 1;
    const n = s.length, stack = [];
    while (i < n) {
      const ch = s[i];
      if (ch === '{') {
        stack.push({ skip, uc }); i++;
        if (s[i] === '\\' && s[i + 1] === '*') skip = true;
        else if (s[i] === '\\') { const m = /^\\([a-zA-Z]+)/.exec(s.slice(i, i + 24)); if (m && SKIP.has(m[1].toLowerCase())) skip = true; }
        continue;
      }
      if (ch === '}') { const st = stack.pop(); if (st) { skip = st.skip; uc = st.uc; } i++; continue; }
      if (ch === '\\') {
        const nx = s[i + 1];
        if (nx === "'") { if (!skip) out += _w1252.decode(new Uint8Array([parseInt(s.substr(i + 2, 2), 16) || 63])); i += 4; continue; }
        if (/[a-zA-Z]/.test(nx)) {
          const m = /^\\([a-zA-Z]+)(-?\d+)? ?/.exec(s.slice(i, i + 40));
          i += m[0].length;
          if (skip) continue;
          const w = m[1], p = m[2];
          if (w === 'par' || w === 'line' || w === 'sect' || w === 'page' || w === 'row') out += '\n';
          else if (w === 'tab') out += '\t';
          else if (w === 'cell') out += ' | ';
          else if (w === 'emdash') out += '—'; else if (w === 'endash') out += '–';
          else if (w === 'u') {
            let cp = parseInt(p, 10); if (cp < 0) cp += 65536;
            out += String.fromCharCode(cp);
            for (let k = 0; k < uc && i < n; k++) { if (s[i] === '\\' && s[i + 1] === "'") i += 4; else i++; }
          } else if (w === 'uc') uc = parseInt(p, 10) || 0;
          continue;
        }
        if (nx === '\\' || nx === '{' || nx === '}') { if (!skip) out += nx; i += 2; continue; }
        if (nx === '~') { if (!skip) out += ' '; i += 2; continue; }
        if (nx === '\r' || nx === '\n') { if (!skip) out += '\n'; i += 2; continue; }
        i += 2; continue;
      }
      if (ch === '\r' || ch === '\n') { i++; continue; }
      if (!skip) out += ch;
      i++;
    }
    return out;
  }
  // Lectura básica para .doc/.ppt antiguos y binarios desconocidos: cadenas de texto legibles.
  function rawStrings(buf, min) {
    min = min || 5;
    const u = new Uint8Array(buf), out = [];
    let cur = '';
    const flush = () => { if (cur.length >= min && /[\p{L}]{3}/u.test(cur)) out.push(cur.trim()); cur = ''; };
    for (let i = 0; i < u.length; i++) { // 8 bits (ASCII/Latin-1/cp1252)
      const b = u[i];
      if ((b >= 32 && b < 127) || b === 9 || (b >= 0xC0 && b <= 0xFF) || b === 0xA1 || b === 0xBF || b === 0xAA || b === 0xBA) cur += String.fromCharCode(b); else flush();
    }
    flush();
    const a8 = out.splice(0);
    for (let i = 0; i + 1 < u.length; i += 2) { // UTF-16LE
      const lo = u[i], hi = u[i + 1];
      if (hi === 0 && ((lo >= 32 && lo < 127) || lo === 9 || lo >= 0xC0)) cur += String.fromCharCode(lo);
      else if (hi > 0 && hi < 0x25 && lo >= 0x20) cur += String.fromCharCode(lo | (hi << 8));
      else flush();
    }
    flush();
    const a16 = out.splice(0);
    const best = a16.join('').length > a8.join('').length * 0.5 ? a16.concat(a8) : a8;
    const seen = new Set();
    return best.filter((l) => { const k = l.slice(0, 60); if (seen.has(k)) return false; seen.add(k); return true; }).join('\n');
  }
  async function zipExtract(file, ctx) {
    if (ctx.depth >= 3) return '';
    const Z = await load(cfg.urls.jszip, 'JSZip');
    const zip = await Z.loadAsync(await file.arrayBuffer());
    const entries = Object.values(zip.files).filter((e) => !e.dir && !/(^|\/)(__MACOSX|\.)/.test(e.name)).slice(0, 300);
    const out = [];
    for (const e of entries) {
      if (cancelFlag) break;
      const nm = e.name.split('/').pop();
      const f = new File([await e.async('blob')], nm);
      let t = '';
      try { t = (await extractInner(f, ctx)).trim(); } catch (err) { t = ''; }
      if (t) out.push('===== ' + e.name + ' =====\n' + t);
    }
    return out.join('\n\n');
  }

  /* ---------- despachador ---------- */
  async function run(kind, file, ctx) {
    switch (kind) {
      case 'text': return decodeText(new Uint8Array(await file.arrayBuffer()));
      case 'html': return htmlToText(decodeText(new Uint8Array(await file.arrayBuffer())));
      case 'rtf': return rtfToText(decodeText(new Uint8Array(await file.arrayBuffer())));
      case 'pdf': return pdfExtract(file, ctx);
      case 'image': return imageExtract(file, ctx);
      case 'svg': return svgExtract(file, ctx);
      case 'docx': return docxExtract(file, ctx);
      case 'pptx': return pptxExtract(file, ctx);
      case 'xlsx': case 'xls': case 'ods': return sheetExtract(file, ctx, kind);
      case 'odf': return odfExtract(file, ctx);
      case 'epub': return epubExtract(file, ctx);
      case 'zip': {
        const k = await zipKind(file);
        return k === 'zip' ? zipExtract(file, ctx) : run(k, file, ctx);
      }
      default: return rawStrings(await file.arrayBuffer());
    }
  }
  async function extractInner(file, ctx) {
    ctx.stats.files++;
    const kind = await detect(file);
    ctx.depth++;
    try { return await run(kind, file, ctx); }
    catch (e) {
      if (['docx', 'pptx', 'xlsx', 'odf', 'epub', 'zip'].includes(kind)) return rawStrings(await file.arrayBuffer()); // archivo dañado o mal etiquetado
      throw e;
    } finally { ctx.depth--; }
  }
  async function extract(file, opts) {
    opts = opts || {};
    const t0 = performance.now();
    const ctx = {
      say: opts.onProgress || (() => {}),
      ocrImages: opts.ocrImages !== undefined ? opts.ocrImages : cfg.ocrImages,
      stats: { ocrPages: 0, ocrImages: 0, files: 0 }, depth: 0, cache: new Map()
    };
    cancelFlag = false;
    acquire();
    try {
      const kind = await detect(file);
      const text = clean(await extractInner(file, ctx));
      return { text, kind, stats: ctx.stats, ms: Math.round(performance.now() - t0) };
    } finally { release(); }
  }

  window.NativeOCR = { version: '1.0', config: cfg, extract, detect, zipKind, cancel: () => { cancelFlag = true; }, _t: { norm, extras, rtfToText, rawStrings, decodeText, htmlToText, linesFrom, layerText } };

  /* =====================================================================
     Integración con ClinQ: reemplaza extractFile y amplía la importación
     (imágenes sueltas, .zip sin JSON, pptx, rtf, html, epub, odt…).
     ===================================================================== */
  function installClinQ() {
    if (typeof window.extractFile !== 'function' || typeof window.handleFiles !== 'function') return;
    const status = () => $('import-status');
    const say = (m) => { const s = status(); if (s) s.textContent = m; };
    const toggle = $('nocr-img');
    try { if (toggle && localStorage.getItem('clinq_ocr_images') === '0') toggle.checked = false; } catch (e) { /* sin localStorage */ }
    if (toggle) toggle.addEventListener('change', () => { try { localStorage.setItem('clinq_ocr_images', toggle.checked ? '1' : '0'); } catch (e) { /* nada */ } });
    const wantOcr = () => (toggle ? toggle.checked : true);

    window.extractFile = async function (file) {
      const r = await extract(file, { onProgress: say, ocrImages: wantOcr() });
      if (!r.text) throw new Error('No se encontró texto legible en el archivo.');
      return r.text;
    };

    const prev = window.handleFiles;
    const isJson = (f) => /\.json$/i.test(f.name);
    async function toTextFile(f) {
      const r = await extract(f, { onProgress: say, ocrImages: true });
      return new File([r.text], f.name + ' (OCR).txt', { type: 'text/plain' });
    }
    window.handleFiles = async function (files) {
      files = [...files];
      const withJson = files.some(isJson);
      const out = [];
      for (const f of files) {
        try {
          const kind = await detect(f);
          if (kind === 'image' || kind === 'svg') {
            if (withJson) out.push(f); else out.push(await toTextFile(f));          // con JSON, las imágenes son de los casos
          } else if (kind === 'zip') {
            const k = await zipKind(f);
            if (k !== 'zip') { out.push(f); continue; }
            const Z = await load(cfg.urls.jszip, 'JSZip');
            const zip = await Z.loadAsync(f);
            const ents = Object.values(zip.files).filter((e) => !e.dir && !/(^|\/)(__MACOSX|\.)/.test(e.name));
            if (ents.some((e) => /\.json$/i.test(e.name)) || withJson) { out.push(f); continue; } // flujo original de casos con imágenes
            for (const e of ents) {
              const sub = new File([await e.async('blob')], e.name.split('/').pop());
              const sk = await detect(sub);
              out.push(sk === 'image' || sk === 'svg' ? await toTextFile(sub) : sub);
            }
          } else out.push(f);
        } catch (e) { out.push(f); }
      }
      return prev.call(this, out);
    };
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', installClinQ); else installClinQ();
})();

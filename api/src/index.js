// Fun fun — 링크 모음 동기화 + 미리보기 API
// - GET  /api/data     : 누구나 읽기 (전체 JSON)
// - PUT  /api/data     : X-Edit-Token 일치 시 전체 저장
// - GET  /api/preview  : X-Edit-Token 필요 — URL 미리보기(YouTube 썸네일 / 일반 OG) 추출
//
// KV: FUNFUN (단일 키 "funfun-data")  ·  Secret: EDIT_TOKEN

const KEY = 'funfun-data';
const MAX_BYTES = 4 * 1024 * 1024;

const ALLOWED_ORIGINS = [
  'https://junyoungcha83.github.io',
  'http://localhost:8000',
  'http://localhost:8080',
  'http://127.0.0.1:8000',
];

function corsHeaders(req) {
  const origin = req.headers.get('Origin') || '';
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Edit-Token',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

function json(body, status, extraHeaders) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...extraHeaders },
  });
}

function isValidShape(parsed) {
  return parsed && typeof parsed === 'object' && Array.isArray(parsed.items);
}

// ── 미리보기 추출 ─────────────────────────────────
function ytId(u) {
  try {
    const url = new URL(u);
    const h = url.hostname.replace(/^www\./, '');
    if (h === 'youtu.be') return url.pathname.slice(1).split('/')[0] || '';
    if (h.endsWith('youtube.com')) {
      if (url.pathname === '/watch') return url.searchParams.get('v') || '';
      const m = url.pathname.match(/^\/(?:shorts|embed|live)\/([^/?#]+)/);
      if (m) return m[1];
    }
  } catch {}
  return '';
}

function pickMeta(html, props) {
  // <meta property="og:image" content="..."> / name="..." — 속성 순서 무관 매칭
  for (const p of props) {
    const re = new RegExp(
      `<meta[^>]+(?:property|name)\\s*=\\s*["']${p}["'][^>]*>`, 'i');
    const tag = html.match(re);
    if (tag) {
      const c = tag[0].match(/content\s*=\s*["']([^"']*)["']/i);
      if (c && c[1]) return c[1].trim();
    }
  }
  return '';
}

function absolutize(maybeUrl, base) {
  if (!maybeUrl) return '';
  try { return new URL(maybeUrl, base).href; } catch { return ''; }
}

async function preview(rawUrl) {
  let url;
  try { url = new URL(rawUrl); } catch { return { error: 'invalid_url' }; }
  if (!/^https?:$/.test(url.protocol)) return { error: 'invalid_url' };
  const domain = url.hostname.replace(/^www\./, '');

  // YouTube — 썸네일 + oEmbed 제목
  const vid = ytId(rawUrl);
  if (vid) {
    let title = '';
    try {
      const o = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(rawUrl)}&format=json`,
        { cf: { cacheTtl: 600 } });
      if (o.ok) { const j = await o.json(); title = (j && j.title) || ''; }
    } catch {}
    return {
      title: title || 'YouTube 영상',
      image: `https://img.youtube.com/vi/${vid}/hqdefault.jpg`,
      domain: 'youtube.com',
    };
  }

  // 일반 URL — OG/title 추출
  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(rawUrl, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; FunfunBot/1.0)' },
    });
    clearTimeout(to);
    if (!res.ok) return { title: domain, image: '', domain };
    // 앞 256KB 만 읽어 메타 파싱(헤드는 보통 앞쪽)
    const buf = await res.arrayBuffer();
    const html = new TextDecoder('utf-8').decode(buf.slice(0, 262144));
    let title = pickMeta(html, ['og:title', 'twitter:title']);
    if (!title) { const t = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i); if (t) title = t[1].trim(); }
    let image = pickMeta(html, ['og:image', 'og:image:url', 'twitter:image', 'twitter:image:src']);
    image = absolutize(image, res.url || rawUrl);
    if (!image) image = `https://www.google.com/s2/favicons?domain=${domain}&sz=128`;
    return {
      title: (title || domain).replace(/\s+/g, ' ').slice(0, 200),
      image,
      domain,
    };
  } catch {
    return { title: domain, image: '', domain };
  }
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const cors = corsHeaders(req);
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });

    if (url.pathname === '/api/data') {
      if (req.method === 'GET') {
        const raw = await env.FUNFUN.get(KEY);
        return new Response(raw || JSON.stringify({ version: 1, items: [] }), {
          headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
        });
      }
      if (req.method === 'PUT') {
        const token = req.headers.get('X-Edit-Token') || '';
        if (!env.EDIT_TOKEN || token !== env.EDIT_TOKEN) return json({ error: 'unauthorized' }, 401, cors);
        const body = await req.text();
        if (body.length > MAX_BYTES) return json({ error: 'too_large' }, 413, cors);
        let parsed;
        try { parsed = JSON.parse(body); } catch { return json({ error: 'invalid_json' }, 400, cors); }
        if (!isValidShape(parsed)) return json({ error: 'invalid_shape' }, 400, cors);
        await env.FUNFUN.put(KEY, body);
        return json({ ok: true, bytes: body.length }, 200, cors);
      }
      return json({ error: 'method_not_allowed' }, 405, cors);
    }

    if (url.pathname === '/api/preview' && req.method === 'GET') {
      const token = req.headers.get('X-Edit-Token') || '';
      if (!env.EDIT_TOKEN || token !== env.EDIT_TOKEN) return json({ error: 'unauthorized' }, 401, cors);
      const target = url.searchParams.get('url') || '';
      if (!target) return json({ error: 'missing_url' }, 400, cors);
      const meta = await preview(target);
      const status = meta.error ? 400 : 200;
      return json(meta, status, cors);
    }

    if (url.pathname === '/' || url.pathname === '/api/health') {
      return json({ ok: true, service: 'funfun-api' }, 200, cors);
    }
    return new Response('Not Found', { status: 404, headers: cors });
  },
};

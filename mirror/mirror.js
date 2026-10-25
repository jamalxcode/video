// video-mirror — serves iptv-org's playlists and API files from Cloudflare, for networks that block
// iptv-org.github.io and the GitHub/jsDelivr mirrors. Only those files, cached for a few hours.
// Use: https://video-mirror.<account>.workers.dev/iptv/index.m3u   (same path as on iptv-org.github.io)
//      https://video-mirror.<account>.workers.dev/api/channels.json

const ORIGINS = [
  'https://iptv-org.github.io/',
  'https://raw.githubusercontent.com/iptv-org/{repo}/gh-pages/',
  'https://cdn.jsdelivr.net/gh/iptv-org/{repo}@gh-pages/',
];
const PATH = /^\/(iptv|api)\/[\w\-./@]+\.(m3u|m3u8|json|xml|txt)$/;
const CACHE_SECONDS = 6 * 3600;
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS' };

export default {
  async fetch(req, env, ctx) {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (req.method !== 'GET' && req.method !== 'HEAD') return reply('Only GET', 405);
    const url = new URL(req.url);
    if (!PATH.test(url.pathname) || url.pathname.includes('..')) return reply('Only iptv-org playlist and API files', 404);

    // Served from Cloudflare's cache when fresh; fetched from iptv-org (or its mirrors) otherwise.
    const cache = caches.default;
    const key = new Request(url.origin + url.pathname, { method: 'GET' });
    const hit = await cache.match(key);
    if (hit) return withCors(hit, 'HIT');

    const [, repo] = url.pathname.match(/^\/(iptv|api)\//);
    const rest = url.pathname.slice(repo.length + 2);
    let res = null, note = '';
    for (const o of ORIGINS) {
      const target = o.includes('{repo}') ? o.replace('{repo}', repo) + rest : o + repo + '/' + rest;
      try {
        const r = await fetch(target, { signal: AbortSignal.timeout(20000), cf: { cacheTtl: 0 } });
        if (r.ok) { res = r; break; }
        note = `HTTP ${r.status} from ${new URL(target).host}`;
      } catch (e) { note = `${new URL(target).host}: ${e.name === 'TimeoutError' ? 'timed out' : e.message}`; }
    }
    if (!res) return reply('iptv-org not reachable right now (' + note + ')', 502);

    const type = url.pathname.endsWith('.json') ? 'application/json; charset=utf-8'
      : url.pathname.endsWith('.xml') ? 'application/xml; charset=utf-8'
      : url.pathname.endsWith('.txt') ? 'text/plain; charset=utf-8'
      : 'audio/x-mpegurl; charset=utf-8';
    const out = new Response(res.body, { status: 200, headers: { 'Content-Type': type, 'Cache-Control': `public, max-age=${CACHE_SECONDS}` } });
    ctx.waitUntil(cache.put(key, out.clone()));
    return withCors(out, 'MISS');
  },
};

function withCors(res, cacheState) {
  const h = new Headers(res.headers);
  for (const [k, v] of Object.entries(CORS)) h.set(k, v);
  h.set('X-Cache', cacheState);
  return new Response(res.body, { status: res.status, headers: h });
}
function reply(text, status) {
  return new Response(text, { status, headers: { ...CORS, 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
}

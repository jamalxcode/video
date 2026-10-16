'use strict';

/* =========================================================================
   Storage — IndexedDB, so everything stays in this browser only.
   Stores: kv (settings, ui, playlist list, playlist texts),
           health (per-stream test + play history, keyed by stream URL),
           favs (favorite channels, keyed by channel key)
   ========================================================================= */
const DB = (() => {
  let dbp;
  const open = () => dbp || (dbp = new Promise((res, rej) => {
    const r = indexedDB.open('m3u-player', 2);
    r.onupgradeneeded = e => {
      const db = r.result;
      if (e.oldVersion < 1) {
        db.createObjectStore('kv');
        db.createObjectStore('health', { keyPath: 'url' });
        db.createObjectStore('favs', { keyPath: 'key' });
        return;
      }
      if (e.oldVersion < 2) {
        // v1 kept favorites per stream URL; v2 keys them per channel.
        r.transaction.objectStore('favs').getAll().onsuccess = ev => {
          db.deleteObjectStore('favs');
          const favs = db.createObjectStore('favs', { keyPath: 'key' });
          for (const f of ev.target.result) favs.put(upgradeFav(f));
        };
      }
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }));
  async function run(store, mode, fn) {
    try {
      const db = await open();
      return await new Promise((res, rej) => {
        const t = db.transaction(store, mode);
        const req = fn(t.objectStore(store));
        t.oncomplete = () => res(req && req.result);
        t.onerror = t.onabort = () => rej(t.error);
      });
    } catch (e) {
      console.warn('Storage error', e);
      return undefined;
    }
  }
  return {
    get: (s, k) => run(s, 'readonly', st => st.get(k)),
    put: (s, v, k) => run(s, 'readwrite', st => (k === undefined ? st.put(v) : st.put(v, k))),
    del: (s, k) => run(s, 'readwrite', st => st.delete(k)),
    all: s => run(s, 'readonly', st => st.getAll()),
    clear: s => run(s, 'readwrite', st => st.clear()),
  };
})();
// Old favorite (one stream URL) -> channel favorite. Re-keyed once its channel is seen in a playlist.
const upgradeFav = f => (f.key ? f : { key: 'u:' + f.url, name: f.name, logo: f.logo, group: f.group,
                                        sources: [{ url: f.url, name: f.name }], addedAt: f.addedAt });

/* =========================================================================
   Helpers
   ========================================================================= */
const $ = s => document.querySelector(s);
const PAGE_HTTPS = location.protocol === 'https:';
// Browsers refuse plain-http media on an https page, so try the https version instead.
const isMixed = url => PAGE_HTTPS && /^http:/i.test(url);
const effectiveUrl = url => (isMixed(url) ? url.replace(/^http:/i, 'https:') : url);
const hostOf = url => { try { return new URL(effectiveUrl(url)).host; } catch { return ''; } };
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtS = ms => (ms / 1000).toFixed(1) + 's';
function ago(t) {
  const s = (Date.now() - t) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return Math.round(s / 60) + ' min ago';
  if (s < 86400) return Math.round(s / 3600) + ' h ago';
  return Math.round(s / 86400) + ' d ago';
}
let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 2600);
}

/* fetch with a timeout; returns { res, abort } */
async function timed(url, ms, opts = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(new DOMException('Timed out', 'TimeoutError')), ms);
  try {
    const res = await fetch(url, { ...opts, signal: ctl.signal, cache: 'no-store' });
    return { res, abort: () => { clearTimeout(timer); ctl.abort(); } };
  } catch (e) {
    clearTimeout(timer);
    throw e;
  }
}
const isTimeout = e => e && (e.name === 'TimeoutError' || e.name === 'AbortError');

/* Video libraries load on demand (warmed up in the background), not before first paint. */
const LIBS = {
  hls: 'https://cdn.jsdelivr.net/npm/hls.js@1.5.17/dist/hls.min.js',
  mpegts: 'https://cdn.jsdelivr.net/npm/mpegts.js@1.7.3/dist/mpegts.min.js',
};
const libLoads = {};
function loadLib(name) {
  return libLoads[name] || (libLoads[name] = new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = LIBS[name];
    s.async = true;
    s.onload = res;
    s.onerror = () => { delete libLoads[name]; s.remove(); rej(new Error('Couldn’t load the video player library')); };
    document.head.appendChild(s);
  }));
}
// Open the connection to a stream's server ahead of time so it starts faster.
const warmed = new Set();
function preconnect(url) {
  let origin;
  try { origin = new URL(effectiveUrl(url)).origin; } catch { return; }
  if (warmed.has(origin) || warmed.size > 60) return;
  warmed.add(origin);
  const l = document.createElement('link');
  l.rel = 'preconnect';
  l.href = origin;
  l.crossOrigin = 'anonymous';
  document.head.appendChild(l);
}

/* =========================================================================
   State
   ========================================================================= */
const DEFAULT_SETTINGS = { slowStartSec: 6, timeoutSec: 15, autoSkip: false, autoTest: true, concurrency: 6 };
// Loaded automatically for first-time visitors (https://github.com/iptv-org/iptv).
const IPTV_ORG = 'https://iptv-org.github.io/iptv/';
const DEFAULT_PLAYLIST = { name: 'iptv-org (all channels)', url: IPTV_ORG + 'index.m3u' };
const REFRESH_AFTER = 24 * 3600e3;   // re-download saved playlists older than this
const FRESH_FOR = 6 * 3600e3;        // test/play results newer than this aren't re-tested
const S = {
  playlists: [],        // [{ id, name, url, count, addedAt, updatedAt }]
  channels: [],         // channels of the selected playlist: { key, name, logo, group, sources: [{ url, name, hdr }] }
  byKey: new Map(),     // channel key -> channel
  byUrl: new Map(),     // stream URL -> channel
  filtered: [],         // what the list currently shows
  health: new Map(),    // stream URL -> health record
  hosts: new Map(),     // server host -> { ok, blocked, dead } from recent tests
  favs: new Map(),      // channel key -> saved channel
  settings: { ...DEFAULT_SETTINGS },
  ui: { currentId: null, search: '', group: '', status: 'all', sort: '', lastKey: '' },
  current: null,
  loading: '',          // message shown in the list while a playlist downloads
};
const saveUi = () => DB.put('kv', { ...S.ui }, 'ui');

/* =========================================================================
   M3U parsing, then merging duplicate entries into one channel with backup sources
   ========================================================================= */
function titleComma(s) {
  let q = false;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '"') q = !q;
    else if (s[i] === ',' && !q) return i;
  }
  return s.length;
}
// Browsers send their own User-Agent and our page as Referer; streams that insist on others won't play.
const needsHeaders = (ua, ref) => !!ref || (!!ua && !/^Mozilla\//i.test(ua));

function parseM3U(text) {
  const out = [];
  let cur = null;
  for (const raw of text.replace(/^﻿/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (/^#EXTINF/i.test(line)) {
      const c = titleComma(line);
      const attrs = {};
      line.slice(0, c).replace(/([\w-]+)="([^"]*)"/g, (_, k, v) => { attrs[k.toLowerCase()] = v; });
      cur = {
        name: line.slice(c + 1).trim() || attrs['tvg-name'] || '',
        logo: attrs['tvg-logo'] || '',
        group: attrs['group-title'] || '',
        id: attrs['tvg-id'] || '',
        ua: attrs['http-user-agent'] || '',
        ref: attrs['http-referrer'] || attrs['http-referer'] || '',
      };
    } else if (/^#EXTGRP:/i.test(line)) {
      if (cur && !cur.group) cur.group = line.slice(8).trim();
    } else if (/^#EXTVLCOPT:/i.test(line)) {
      const m = line.match(/^#EXTVLCOPT:http-(user-agent|referr?er)=(.*)$/i);
      if (cur && m) cur[m[1].toLowerCase() === 'user-agent' ? 'ua' : 'ref'] = m[2].trim();
    } else if (!line.startsWith('#')) {
      const [urlPart, opts = ''] = line.split('|'); // Kodi style: url|User-Agent=…&Referer=…
      const url = urlPart.trim();
      if (!/^(https?|rtmp|rtsp|udp):\/\//i.test(url) && !url.includes('/')) { cur = null; continue; }
      const ua = cur?.ua || (opts.match(/user-agent=([^&]*)/i) || [])[1] || '';
      const ref = cur?.ref || (opts.match(/referr?er=([^&]*)/i) || [])[1] || '';
      out.push({
        name: cur?.name || url.split('/').pop() || 'Unnamed',
        logo: cur?.logo || '',
        group: cur?.group || 'Ungrouped',
        id: cur?.id || '',
        url,
        hdr: needsHeaders(ua, ref),
      });
      cur = null;
    }
  }
  return out;
}

const QUALITY = /\b(hd|fhd|uhd|sd|4k|hevc|h\.?265)\b/gi;
const cleanName = n => n.replace(/\([^)]*\)|\[[^\]]*\]/g, ' ').replace(QUALITY, ' ').replace(/\s+/g, ' ').trim();
function channelKey(e) {
  // iptv-org ids are "Channel.cc@Feed". Quality feeds (@SD, @HD…) are the same channel;
  // other feeds are different channels (regional stations like ABC.us@KAAL, country versions like @DK).
  const [id, feed = ''] = e.id.trim().split('@');
  if (id) return 'id:' + (/^(sd|hd|fhd|uhd|4k|hevc)?$/i.test(feed) ? id : id + '@' + feed).toLowerCase();
  return 'n:' + cleanName(e.name).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim() + '|' + e.group.toLowerCase();
}
function mergeChannels(entries) {
  const map = new Map();
  for (const e of entries) {
    const key = channelKey(e);
    let ch = map.get(key);
    if (!ch) {
      ch = { key, name: cleanName(e.name) || e.name, logo: e.logo, group: e.group, sources: [] };
      map.set(key, ch);
    } else {
      if (!ch.logo) ch.logo = e.logo;
      const cn = cleanName(e.name);
      if (cn && cn.length < ch.name.length) ch.name = cn;
      const groups = new Set(groupsOf(ch));
      for (const g of e.group.split(';')) if (g.trim()) groups.add(g.trim());
      ch.group = [...groups].join(';');
    }
    if (!ch.sources.some(s => s.url === e.url)) ch.sources.push({ url: e.url, name: e.name, hdr: e.hdr });
  }
  return [...map.values()];
}
const buildChannels = text => mergeChannels(parseM3U(text));

/* =========================================================================
   Health: what we know about each stream, and the badge it gets
   ========================================================================= */
function H(url) {
  let h = S.health.get(url);
  if (!h) {
    h = { url, plays: 0, ok: 0, slow: 0, fails: 0, stalls: 0, avgStartMs: 0, lastStartMs: 0,
          lastResult: '', lastNote: '', lastPlay: 0, probe: null, rating: '', kind: '' };
    S.health.set(url, h);
  }
  return h;
}
function saveH(h) {
  DB.put('health', h);
  scheduleRender();
  if (S.current && S.current.sources.some(s => s.url === h.url)) renderNow();
}
const mk = (cls, label, tip) => ({ cls, label, tip });
const RANK = { good: 0, warn: 1, untested: 2, blocked: 3, bad: 4 };

function fromHistory(h) {
  const tip = `You played it ${h.plays}×: ${h.fails} failed, ${h.stalls} with heavy buffering`;
  if (h.lastResult === 'fail') return mk('bad', 'Failed', `Failed last time (${h.lastNote || 'error'}). ${tip}`);
  if (h.plays >= 3 && h.fails / h.plays >= 0.5) return mk('bad', 'Unreliable', tip);
  if (h.lastResult === 'stall') return mk('warn', 'Buffers', `Kept buffering last time. ${tip}`);
  if (h.lastResult === 'slow') return mk('warn', 'Slow start', `Took ${fmtS(h.lastStartMs)} to start. ${tip}`);
  return mk('good', 'Worked', `Started in ${fmtS(h.lastStartMs)}. ${tip}`);
}
function fromProbe(p) {
  const tip = `${p.note ? p.note + '. ' : ''}Tested ${ago(p.at)}`;
  switch (p.status) {
    case 'ok': return mk('good', 'Fast', tip);
    case 'slow': return mk('warn', 'Slow', tip);
    case 'dead': return mk('bad', 'Offline', tip);
    case 'blocked': return mk('blocked', 'Blocked', tip);
  }
  return mk('untested', '', tip);
}
// Status of one stream (source).
function sourceStatus(src) {
  const h = S.health.get(src.url);
  if (h?.rating === 'good') return mk('good', 'Smooth ★', 'You rated this smooth');
  if (h?.rating === 'buffers') return mk('warn', 'Buffers ★', 'You rated this as buffering');
  if (h?.rating === 'broken') return mk('bad', 'Broken ★', 'You rated this broken');
  const hist = h?.lastPlay ? fromHistory(h) : null;
  const pr = h?.probe ? fromProbe(h.probe) : null;
  if (hist && pr) return h.lastPlay >= h.probe.at ? hist : pr; // newest evidence wins
  if (hist || pr) return hist || pr;
  if (src.hdr) return mk('blocked', 'Needs app', 'This stream requires a special header (User-Agent/Referer) that browsers can’t send; it will probably only play in apps like VLC');
  if (isMixed(src.url)) return mk('untested', 'HTTP', 'Plain-HTTP stream: browsers may block it on this HTTPS page');
  return mk('untested', '', 'Not tested yet');
}
// Sources best-first: what worked before, then untested, then known-bad. HTTPS beats HTTP on an HTTPS page.
function orderedSources(ch) {
  return ch.sources
    .map((s, i) => ({ s, r: RANK[sourceStatus(s).cls] + (isMixed(s.url) ? 0.5 : 0), i }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map(x => x.s);
}
// A channel is as good as its best source.
function channelStatus(ch) {
  if (ch.sources.length === 1) return sourceStatus(ch.sources[0]);
  let best = null;
  let working = 0;
  for (const s of ch.sources) {
    const st = sourceStatus(s);
    if (RANK[st.cls] <= 1) working++;
    if (!best || RANK[st.cls] < RANK[best.cls]) best = st;
  }
  return { ...best, tip: `${best.tip} · ${ch.sources.length} sources${working ? `, ${working} working` : ''}` };
}
const isBadCls = cls => cls === 'bad' || cls === 'blocked';
const lastSeen = src => { const h = S.health.get(src.url); return Math.max(h?.probe?.at || 0, h?.lastPlay || 0); };
const isFresh = src => !!S.health.get(src.url)?.rating || lastSeen(src) > Date.now() - FRESH_FOR;
const hasFreshWorking = ch => ch.sources.some(s => isFresh(s) && RANK[sourceStatus(s).cls] <= 1);

/* =========================================================================
   Stream tester — light: reads only the first part of a video chunk, at most
   2 tests per server at once, and skips servers already known to block or be down.
   ========================================================================= */
async function readFirst(res, maxBytes, maxMs) {
  const reader = res.body.getReader();
  const chunks = [];
  let bytes = 0;
  let done = false;
  const t0 = performance.now();
  try {
    while (bytes < maxBytes && performance.now() - t0 < maxMs) {
      const r = await reader.read();
      if (r.done) { done = true; break; }
      chunks.push(r.value);
      bytes += r.value.length;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  const all = new Uint8Array(bytes);
  let o = 0;
  for (const c of chunks) { all.set(c, o); o += c.length; }
  return { data: all, ms: performance.now() - t0, done };
}

async function probe(url) {
  const target = effectiveUrl(url);
  const base = { at: Date.now() };
  const t0 = performance.now();
  let r;
  try {
    r = await timed(target, 8000);
  } catch (e) {
    if (isTimeout(e)) return { ...base, status: 'dead', scope: 'host', note: 'No response within 8s' };
    // Network error or CORS block: check whether the server answers at all.
    try {
      const r2 = await timed(target, 6000, { mode: 'no-cors' });
      r2.abort();
      return { ...base, status: 'blocked', scope: 'host',
               note: 'Server is online but blocks web players (CORS), so it usually won’t play in a browser (Safari sometimes can)' };
    } catch {
      if (target !== url) return { ...base, status: 'blocked', scope: 'host', note: 'HTTP-only stream: browsers block it on an HTTPS page' };
      return { ...base, status: 'dead', scope: 'host', note: 'Server not reachable' };
    }
  }
  base.ms = Math.round(performance.now() - t0);
  try {
    if (!r.res.ok) { r.abort(); return { ...base, status: 'dead', note: `Server error (HTTP ${r.res.status})` }; }
    const first = await readFirst(r.res, 512 * 1024, 3000);
    r.abort();
    const head = new TextDecoder().decode(first.data.slice(0, 32)).replace(/^﻿/, '');
    if (head.startsWith('#EXTM3U')) {
      return { kind: 'hls', ...(await probeHls(new TextDecoder().decode(first.data), r.res.url || target, base)) };
    }
    // Direct stream (MPEG-TS, FLV, MP4…): measure raw download speed.
    const kind = head.startsWith('FLV') ? 'flv' : first.data[0] === 0x47 ? 'mpegts' : 'native';
    if (first.data.length < 64 * 1024 && !first.done) return { ...base, kind, status: 'slow', note: `Responds in ${base.ms} ms but sends almost no data` };
    const mbps = (first.data.length * 8) / (Math.max(first.ms, 1) / 1000) / 1e6;
    const status = (first.done || mbps >= 3) && base.ms < 4000 ? 'ok' : 'slow';
    return { ...base, kind, status, note: `Responds in ${base.ms} ms, downloads at ${mbps.toFixed(1)} Mbit/s` };
  } catch (e) {
    r.abort();
    if (isTimeout(e)) return { ...base, status: 'slow', note: 'Responded, then stalled while downloading' };
    return { ...base, status: 'dead', note: String(e.message || e) };
  }
}

async function probeHls(text, baseUrl, base) {
  let lines = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  let bandwidth = 0;
  if (lines.some(l => l.startsWith('#EXT-X-STREAM-INF'))) {
    // Master playlist: check the lowest quality, since the player starts there and adapts.
    let uri = null, best = Infinity;
    lines.forEach((l, i) => {
      if (!l.startsWith('#EXT-X-STREAM-INF')) return;
      const bw = +(l.match(/[:,]BANDWIDTH=(\d+)/) || [])[1] || Infinity;
      const u = lines.slice(i + 1).find(x => !x.startsWith('#'));
      if (u && (uri === null || bw < best)) { uri = u; best = bw; }
    });
    if (!uri) return { ...base, status: 'dead', note: 'Playlist lists no streams' };
    bandwidth = Number.isFinite(best) ? best : 0;
    const vurl = new URL(uri, baseUrl).href;
    const r = await timed(vurl, 8000);
    if (!r.res.ok) { r.abort(); return { ...base, status: 'dead', note: `Stream playlist missing (HTTP ${r.res.status})` }; }
    text = await r.res.text();
    r.abort();
    baseUrl = r.res.url || vurl;
    lines = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  }
  const segs = [];
  let pend = null;
  for (const l of lines) {
    if (l.startsWith('#EXTINF:')) pend = parseFloat(l.slice(8)) || 0;
    else if (!l.startsWith('#') && pend !== null) { segs.push({ d: pend, u: l }); pend = null; }
  }
  if (!segs.length) return { ...base, status: 'dead', note: 'Stream has no video segments' };
  const live = !lines.some(l => l.startsWith('#EXT-X-ENDLIST'));
  const seg = live ? segs[Math.max(0, segs.length - 2)] : segs[0];
  let r;
  try {
    r = await timed(new URL(seg.u, baseUrl).href, 10000);
  } catch (e) {
    if (isTimeout(e)) return { ...base, status: 'slow', note: 'Video segments respond too slowly' };
    return { ...base, status: 'blocked', note: 'Video segments are blocked for web players (CORS)' };
  }
  let part;
  try {
    if (!r.res.ok) { r.abort(); return { ...base, status: 'dead', note: `Video segments missing (HTTP ${r.res.status})` }; }
    part = await readFirst(r.res, 768 * 1024, 4000); // a sample is enough to judge speed
    r.abort();
  } catch {
    r.abort();
    return { ...base, status: 'slow', note: 'Video segment download stalled' };
  }
  // How fast it downloads vs. how fast it plays: content bitrate from the segment size, else the playlist.
  const len = +r.res.headers.get('content-length') || (part.done ? part.data.length : 0);
  const contentBps = len && seg.d ? (len * 8) / seg.d : bandwidth;
  const dlBps = (part.data.length * 8) / (Math.max(part.ms, 30) / 1000);
  const ratio = contentBps ? dlBps / contentBps : 0;
  let status = 'ok';
  let note = ratio
    ? `Responds in ${base.ms} ms, video downloads ${ratio.toFixed(1)}× faster than real time`
    : `Responds in ${base.ms} ms, downloads at ${(dlBps / 1e6).toFixed(1)} Mbit/s`;
  if (ratio && ratio < 1) { status = 'slow'; note = `Video downloads slower than real time (${ratio.toFixed(1)}×), so it will buffer`; }
  else if ((ratio && ratio < 1.5) || (!ratio && dlBps < 3e6) || base.ms > 4000) status = 'slow';
  return { ...base, status, ratio: +ratio.toFixed(1), note };
}

function noteHost(url, p) {
  const host = hostOf(url);
  const hs = S.hosts.get(host) || { ok: 0, blocked: 0, dead: 0 };
  if (p.status === 'ok' || p.status === 'slow') hs.ok++;
  else if (p.scope === 'host') hs[p.status === 'blocked' ? 'blocked' : 'dead']++;
  S.hosts.set(host, hs);
}
// If other streams on the same server were all blocked/unreachable, don't bother testing this one.
function inferFromHost(url) {
  const hs = S.hosts.get(hostOf(url));
  if (!hs || hs.ok) return null;
  const at = Date.now();
  if (hs.blocked >= 2) return { at, status: 'blocked', inferred: true, note: 'Not tested: other channels on this server block web players' };
  if (hs.dead >= 2) return { at, status: 'dead', inferred: true, note: 'Not tested: this server didn’t respond for other channels' };
  return null;
}
// Next source of a channel worth testing (best-first, not tested recently, not header-locked).
const nextTestable = ch => orderedSources(ch).find(s => !isFresh(s) && !s.hdr && !T.queued.has(s.url));

const PER_HOST = 2;
const T = { queue: [], queued: new Set(), force: new Set(), hostActive: new Map(), active: 0, done: 0, total: 0, manual: false };
function queueTests(urls, { manual = false, force = false, front = false } = {}) {
  if (manual) { T.queue = []; T.queued.clear(); T.done = 0; T.total = T.active; T.manual = true; }
  const add = [];
  for (const u of urls) {
    if (T.queued.has(u)) continue;
    T.queued.add(u);
    if (force) T.force.add(u);
    add.push(u);
    T.total++;
  }
  if (front) T.queue.unshift(...add); else T.queue.push(...add);
  pump();
  updateTestUi();
}
function stopTests() {
  for (const u of T.queue) T.queued.delete(u);
  T.total -= T.queue.length;
  T.queue = [];
  T.manual = false;
  updateTestUi();
}
function pickNext() {
  const lim = Math.min(T.queue.length, 300);
  for (let i = 0; i < lim; i++) {
    if ((T.hostActive.get(hostOf(T.queue[i])) || 0) < PER_HOST) return T.queue.splice(i, 1)[0];
  }
  return null;
}
function finishTest(url) {
  T.done++;
  T.queued.delete(url);
  T.force.delete(url);
  if (!T.active && !T.queue.length) { T.manual = false; T.done = T.total = 0; }
  updateTestUi();
}
function recordProbe(url, p) {
  const h = H(url);
  if (p.kind) h.kind = p.kind;
  h.probe = p;
  saveH(h);
  if (!p.inferred) noteHost(url, p);
  // This source is bad: test the channel's next backup source right away.
  if (isBadCls(fromProbe(p).cls)) {
    const ch = S.byUrl.get(url);
    const next = ch && !hasFreshWorking(ch) && nextTestable(ch);
    if (next) queueTests([next.url], { front: true });
  }
}
function pump() {
  while (T.active < S.settings.concurrency && T.queue.length) {
    const url = pickNext();
    if (!url) break;
    const inferred = !T.force.has(url) && inferFromHost(url);
    if (inferred) { recordProbe(url, inferred); finishTest(url); continue; }
    const host = hostOf(url);
    T.active++;
    T.hostActive.set(host, (T.hostActive.get(host) || 0) + 1);
    probe(url)
      .catch(e => ({ at: Date.now(), status: 'dead', note: String(e.message || e) }))
      .then(p => recordProbe(url, p))
      .finally(() => {
        T.active--;
        T.hostActive.set(host, T.hostActive.get(host) - 1);
        finishTest(url);
        pump();
      });
  }
}
function updateTestUi() {
  const busy = T.active > 0 || T.queue.length > 0;
  $('#testBtn').textContent = T.manual && busy ? 'Stop testing' : 'Test channels';
  $('#testProgress').textContent = busy ? `Testing ${T.done}/${T.total}…` : '';
}
function testUrlsFor(channels) {
  const urls = [];
  for (const ch of channels) {
    if (hasFreshWorking(ch)) continue;
    const s = nextTestable(ch);
    if (s) urls.push(s.url);
  }
  return urls;
}
function autoTestVisible() {
  if (!S.settings.autoTest) return;
  const list = $('#list');
  const start = Math.floor(list.scrollTop / ROW);
  const end = Math.min(S.filtered.length, Math.ceil((list.scrollTop + listHeight()) / ROW));
  const urls = testUrlsFor(S.filtered.slice(start, end));
  if (urls.length) queueTests(urls);
}

/* =========================================================================
   Channel list (virtualized — handles playlists with tens of thousands of entries)
   ========================================================================= */
const ROW = 56;
// Fallback for when the list has no layout yet (hidden tab, first paint).
const listHeight = () => $('#list').clientHeight || window.innerHeight || 800;
let renderPending = false;
function scheduleRender() {
  if (renderPending) return;
  renderPending = true;
  const go = () => { if (renderPending) { renderPending = false; renderList(); } };
  requestAnimationFrame(go);
  setTimeout(go, 100); // rAF doesn't fire in background tabs
}
function renderList() {
  const list = $('#list');
  const inner = $('#listInner');
  const n = S.filtered.length;
  if (!n) {
    inner.style.height = 'auto';
    inner.innerHTML = S.loading
      ? `<div class="empty"><div class="spinner"></div>${esc(S.loading)}</div>`
      : !S.playlists.length
      ? '<div class="empty">No playlist yet.<br><button class="primary" data-act="add">+ Add a playlist</button></div>'
      : S.ui.status === 'fav' && !S.favs.size
        ? '<div class="empty">No favorites yet.<br>Tap ☆ next to a channel to save it here.</div>'
        : '<div class="empty">No channels match.</div>';
    return;
  }
  inner.style.height = n * ROW + 'px';
  const start = Math.max(0, Math.floor(list.scrollTop / ROW) - 6);
  const end = Math.min(n, Math.ceil((list.scrollTop + listHeight()) / ROW) + 6);
  let html = '';
  for (let i = start; i < end; i++) {
    const ch = S.filtered[i];
    const st = channelStatus(ch);
    const fav = S.favs.has(ch.key);
    const active = S.current && S.current.key === ch.key;
    const more = ch.sources.length > 1 ? ` · ${ch.sources.length} sources` : '';
    html += `<div class="ch${active ? ' active' : ''}" data-i="${i}" style="top:${i * ROW}px" title="${esc(st.tip)}">
      <div class="logo">${ch.logo ? `<img src="${esc(ch.logo)}" loading="lazy" referrerpolicy="no-referrer" alt="" onerror="this.remove()">` : '▶'}</div>
      <div class="info"><div class="name">${esc(ch.name)}</div><div class="grp">${esc(groupLabel(ch) + more)}</div></div>
      <span class="badge ${st.cls}"><i></i>${esc(st.label)}</span>
      <button class="star${fav ? ' on' : ''}" data-star="${i}" title="${fav ? 'Remove from' : 'Add to'} favorites">${fav ? '★' : '☆'}</button>
    </div>`;
  }
  inner.innerHTML = html;
}
// A channel can sit in several groups, written "News;Sports" (iptv-org does this).
const groupsOf = ch => ch.group.split(';').map(g => g.trim()).filter(Boolean);
const groupLabel = ch => groupsOf(ch).join(', ');
function passStatus(cls, f) {
  if (f === 'good') return cls === 'good';
  if (f === 'hideBad') return !isBadCls(cls);
  if (f === 'untested') return cls === 'untested';
  return true;
}
function sourceChannels() {
  return S.ui.status === 'fav'
    ? [...S.favs.values()].map(f => S.byKey.get(f.key) || f).sort((a, b) => a.name.localeCompare(b.name))
    : S.channels;
}
function rebuildGroups() {
  const src = sourceChannels();
  const counts = new Map();
  for (const c of src) for (const g of groupsOf(c)) counts.set(g, (counts.get(g) || 0) + 1);
  const groups = [...counts.keys()].sort((a, b) => a.localeCompare(b));
  if (!counts.has(S.ui.group)) S.ui.group = '';
  $('#groupFilter').innerHTML = `<option value="">All groups (${groups.length})</option>` +
    groups.map(g => `<option value="${esc(g)}"${g === S.ui.group ? ' selected' : ''}>${esc(g)} (${counts.get(g)})</option>`).join('');
}
function applyFilters(keepScroll = false) {
  const q = S.ui.search.toLowerCase().trim();
  const g = S.ui.group;
  const f = S.ui.status;
  const needStatus = (f !== 'all' && f !== 'fav') || S.ui.sort === 'best';
  const rows = [];
  for (const ch of sourceChannels()) {
    if (q && !ch.name.toLowerCase().includes(q) && !ch.group.toLowerCase().includes(q)) continue;
    if (g && !groupsOf(ch).includes(g)) continue;
    const cls = needStatus ? channelStatus(ch).cls : '';
    if (!passStatus(cls, f)) continue;
    rows.push({ ch, r: RANK[cls] ?? 0 });
  }
  if (S.ui.sort === 'best') rows.sort((a, b) => a.r - b.r);
  else if (S.ui.sort === 'name') rows.sort((a, b) => a.ch.name.localeCompare(b.ch.name));
  S.filtered = rows.map(x => x.ch);
  const total = sourceChannels().length;
  $('#count').textContent = S.filtered.length === total ? `${total} channels` : `${S.filtered.length} of ${total}`;
  if (!keepScroll) $('#list').scrollTop = 0;
  renderList();
  clearTimeout(scrollIdle);
  scrollIdle = setTimeout(autoTestVisible, 400);
}
function scrollToCurrent() {
  if (!S.current) return;
  const i = S.filtered.findIndex(c => c.key === S.current.key);
  if (i < 0) return;
  const list = $('#list');
  const y = i * ROW;
  if (y < list.scrollTop || y + ROW > list.scrollTop + listHeight()) {
    list.scrollTop = y - listHeight() / 2 + ROW / 2;
  }
}

/* =========================================================================
   Playback: hls.js for HLS, mpegts.js for raw TS/FLV, the browser for the rest.
   A channel's sources are tried best-first; if one fails or hangs, the next one
   takes over automatically. Every attempt is measured and remembered.
   ========================================================================= */
const video = $('#video');
let hls = null, mpeg = null, engine = '', nativeFail = null;
let playToken = 0, session = null, startTimer = null;

function teardown() {
  if (hls) { hls.destroy(); hls = null; }
  if (mpeg) {
    try { mpeg.pause(); mpeg.unload(); mpeg.detachMediaElement(); mpeg.destroy(); } catch { /* already gone */ }
    mpeg = null;
  }
  nativeFail = null;
  engine = '';
  video.removeAttribute('src');
  video.load();
}
function kindOf(url) {
  const p = url.split(/[?#]/)[0].toLowerCase();
  if (p.endsWith('.m3u8') || p.endsWith('.m3u')) return 'hls';
  if (p.endsWith('.ts')) return 'mpegts';
  if (p.endsWith('.flv')) return 'flv';
  if (/\.(mp4|m4v|webm|ogv|mkv|mov|mp3|m4a|aac|ogg|opus)$/.test(p)) return 'native';
  return '';
}
// URL has no telling extension and we haven't seen it before: peek at the first bytes.
async function sniff(url) {
  try {
    const r = await timed(url, 8000);
    const ct = (r.res.headers.get('content-type') || '').toLowerCase();
    if (ct.includes('mpegurl')) { r.abort(); return 'hls'; }
    const reader = r.res.body.getReader();
    const { value } = await reader.read();
    reader.cancel().catch(() => {});
    r.abort();
    if (!value) return 'native';
    const head = new TextDecoder().decode(value.slice(0, 16)).replace(/^﻿/, '');
    if (head.startsWith('#EXTM3U')) return 'hls';
    if (head.startsWith('FLV')) return 'flv';
    if (value[0] === 0x47) return 'mpegts';
    return 'native';
  } catch {
    return 'native'; // can't look inside (CORS) — let the browser try directly
  }
}
function hlsMessage(d) {
  const code = d.response?.code;
  if (d.details === 'manifestLoadError') return code ? `Server returned HTTP ${code}` : 'Server is offline or blocks web players';
  if (d.details === 'manifestLoadTimeOut') return 'Server took too long to answer';
  if (d.details === 'manifestParsingError') return 'Not a valid stream';
  if (/^frag|^level/.test(d.details)) return 'Video data failed to load';
  return d.details || 'Playback error';
}
const currentSourceUrl = () =>
  (session && S.current && session.ch.key === S.current.key ? session.url : S.current && orderedSources(S.current)[0].url);
const hasBackup = () => session && session.idx < session.order.length - 1;

function playChannel(ch, startUrl) {
  leaveSession();
  teardown();
  S.current = ch;
  S.ui.lastKey = ch.key;
  saveUi();
  let order = orderedSources(ch);
  if (startUrl) order = [order.find(s => s.url === startUrl), ...order.filter(s => s.url !== startUrl)].filter(Boolean);
  session = { ch, order, idx: -1 };
  scheduleRender();
  scrollToCurrent();
  nextSource();
}

// Start the next source of the current channel. Returns false when there are none left.
function nextSource() {
  const s = session;
  if (!s || s.idx + 1 >= s.order.length) return false;
  s.idx++;
  teardown();
  const token = ++playToken;
  Object.assign(s, { url: s.order[s.idx].url, t0: performance.now(), started: false, failed: false, recorded: false, stalls: 0, token });
  renderNow();
  showOverlay('<div class="spinner"></div>' + (s.idx ? `Trying backup source ${s.idx + 1} of ${s.order.length}…` : 'Loading…'));
  clearTimeout(startTimer);
  startTimer = setTimeout(() => onTimeout(token), S.settings.timeoutSec * 1000);
  const url = effectiveUrl(s.url);
  (async () => {
    const h = S.health.get(s.url);
    let kind = h?.kind || kindOf(url);
    if (!kind) {
      kind = await sniff(url);
      H(s.url).kind = kind; // saved with the play result
    }
    if (kind === 'hls') await loadLib('hls').catch(() => {});
    else if (kind === 'mpegts' || kind === 'flv') await loadLib('mpegts').catch(() => {});
    if (token !== playToken) return;
    startEngine(kind, url, token);
  })();
  return true;
}

function startEngine(kind, url, token) {
  const fail = msg => { if (token === playToken) onPlayFail(msg); };
  if (kind === 'hls') {
    if (window.Hls && Hls.isSupported()) {
      engine = 'hls';
      hls = new Hls({
        enableWorker: true,
        startLevel: 0,                // start at the lowest quality for a fast first picture, then adapt up
        capLevelToPlayerSize: true,   // don't fetch 1080p for a small player
        startFragPrefetch: true,
        liveSyncDurationCount: 4,     // a bit more safety margin behind the live edge = fewer stalls
        backBufferLength: 30,
        manifestLoadingTimeOut: 10000, levelLoadingTimeOut: 10000, fragLoadingTimeOut: 20000,
      });
      let recovered = false;
      hls.on(Hls.Events.ERROR, (_, d) => {
        if (!d.fatal) return;
        if (d.type === Hls.ErrorTypes.MEDIA_ERROR && !recovered) { recovered = true; hls.recoverMediaError(); return; }
        fail(hlsMessage(d));
      });
      hls.on(Hls.Events.MANIFEST_PARSED, () => video.play().catch(() => {}));
      hls.loadSource(url);
      hls.attachMedia(video);
      return;
    }
    if (!video.canPlayType('application/vnd.apple.mpegurl')) return fail('This browser can’t play HLS streams');
  } else if (kind === 'mpegts' || kind === 'flv') {
    if (window.mpegts && mpegts.isSupported()) {
      engine = 'mpegts';
      mpeg = mpegts.createPlayer({ type: kind, isLive: true, url },
        { enableWorker: false, lazyLoad: false, liveBufferLatencyChasing: true });
      mpeg.on(mpegts.Events.ERROR, (type, detail) => fail(`Stream error (${detail || type})`));
      mpeg.attachMediaElement(video);
      mpeg.load();
      video.play().catch(() => {});
      return;
    }
  }
  engine = 'native';
  nativeFail = fail;
  video.src = url;
  video.play().catch(() => {});
}

function recordFail(s, msg, countPlay) {
  const h = H(s.url);
  if (countPlay) h.plays++;
  h.fails++;
  h.lastResult = 'fail';
  h.lastNote = msg;
  h.lastPlay = Date.now();
  s.recorded = true;
  saveH(h);
}

function onTimeout(token) {
  const s = session;
  if (token !== playToken || !s || s.started || s.failed) return;
  if (hasBackup()) {
    s.failed = true;
    recordFail(s, `didn’t start within ${S.settings.timeoutSec}s`, true);
    nextSource();
    return;
  }
  if (S.settings.autoSkip) return onPlayFail(`Didn’t start within ${S.settings.timeoutSec}s`);
  showOverlay(`<b>⏳ Still loading after ${S.settings.timeoutSec}s</b><div class="muted">This channel is slow or offline right now.</div>`,
    [['wait', 'Keep waiting'], ['next', 'Next channel'], ['broken', 'Mark broken & skip']]);
}

function onPlayFail(msg) {
  const s = session;
  if (!s || s.failed) return;
  s.failed = true;
  clearTimeout(startTimer);
  recordFail(s, msg, !s.started);
  teardown();
  if (!s.started && nextSource()) return; // a backup source takes over
  if (S.settings.autoSkip && !s.started) {
    showOverlay(`✖ ${esc(msg)}<div class="muted">Skipping to the next working channel…</div>`);
    setTimeout(() => { if (s.token === playToken) step(1, true); }, 1500);
    return;
  }
  const tried = s.order.length > 1 ? ` (tried all ${s.order.length} sources)` : '';
  showOverlay(`<b>✖ Couldn’t play this channel${tried}</b><div class="muted">${esc(msg)}</div>`,
    [['next', 'Next channel'], ['retry', 'Retry'], ['copy', 'Copy link for VLC']]);
}

// Leaving a source that never started counts as a failure if we waited long enough.
function leaveSession() {
  const s = session;
  if (!s) return;
  clearTimeout(startTimer);
  const waited = performance.now() - s.t0;
  if (s.url && !s.started && !s.recorded && waited >= S.settings.slowStartSec * 1000) {
    recordFail(s, `didn’t start after ${Math.round(waited / 1000)}s`, true);
  }
  session = null;
}

video.addEventListener('playing', () => {
  const s = session;
  if (!s || s.token !== playToken) return;
  hideOverlay();
  if (s.started) return;
  s.started = true;
  clearTimeout(startTimer);
  const ms = performance.now() - s.t0;
  const h = H(s.url);
  const n = h.ok + h.slow;
  h.avgStartMs = Math.round((h.avgStartMs * n + ms) / (n + 1));
  h.lastStartMs = Math.round(ms);
  h.plays++;
  h.lastPlay = Date.now();
  if (ms > S.settings.slowStartSec * 1000) { h.slow++; h.lastResult = 'slow'; }
  else { h.ok++; h.lastResult = 'ok'; }
  s.recorded = true;
  saveH(h);
  // Warm up the connection to the next channel so switching feels instant.
  const i = S.filtered.findIndex(c => c.key === s.ch.key);
  const next = S.filtered[i + 1];
  if (next) preconnect(orderedSources(next)[0].url);
});
video.addEventListener('waiting', () => {
  const s = session;
  if (!s?.started || s.token !== playToken || s.failed) return;
  s.stalls++;
  if (s.stalls === 3) {
    const h = H(s.url);
    h.stalls++;
    h.lastResult = 'stall';
    h.lastPlay = Date.now();
    saveH(h);
  }
  if (s.stalls >= 3) {
    const acts = [['next', 'Next channel'], ['rate-buffers', 'Rate “Buffers”']];
    if (hasBackup()) acts.unshift(['switch', 'Try backup source']);
    showOverlay('<div class="spinner"></div>Buffering again… this source keeps stalling.', acts);
  } else {
    showOverlay('<div class="spinner"></div>Buffering…');
  }
});
video.addEventListener('error', () => {
  if (engine !== 'native' || !nativeFail || !video.error) return;
  const why = ['', 'aborted', 'network error', 'decode error', 'format not supported or blocked'][video.error.code] || 'error';
  nativeFail(`Browser couldn’t play it (${why})`);
});
window.addEventListener('pagehide', leaveSession);

function step(dir, skipBad = false) {
  const list = S.filtered;
  if (!list.length) return;
  let i = S.current ? list.findIndex(c => c.key === S.current.key) : -1;
  if (i < 0 && dir < 0) i = 0;
  for (let n = 0; n < list.length; n++) {
    i = (i + dir + list.length) % list.length;
    if (!skipBad || !isBadCls(channelStatus(list[i]).cls)) return playChannel(list[i]);
  }
  toast('No working channels left in this list');
}

/* =========================================================================
   Overlay + "now playing" panel
   ========================================================================= */
function showOverlay(html, actions = []) {
  const el = $('#overlay');
  el.innerHTML = html + (actions.length
    ? `<div class="acts">${actions.map(([a, l]) => `<button data-act="${a}">${esc(l)}</button>`).join('')}</div>` : '');
  el.classList.remove('hidden');
}
function hideOverlay() { $('#overlay').classList.add('hidden'); }

function renderNow() {
  const ch = S.current;
  for (const b of document.querySelectorAll('.rate button, #favBtn, #prevBtn, #nextBtn')) b.disabled = !ch;
  if (!ch) return;
  const url = currentSourceUrl();
  const src = ch.sources.find(s => s.url === url) || ch.sources[0];
  const st = channelStatus(ch);
  const h = S.health.get(src.url);
  $('#nowName').textContent = ch.name;
  $('#nowMeta').innerHTML = `${esc(groupLabel(ch))} · <span class="badge ${st.cls}"><i></i>${esc(st.label || 'Untested')}</span>`;
  const logo = $('#nowLogo');
  logo.classList.toggle('hidden', !ch.logo);
  if (ch.logo) { logo.src = ch.logo; logo.onerror = () => logo.classList.add('hidden'); }
  const fav = S.favs.has(ch.key);
  $('#favBtn').textContent = fav ? '★ Favorite' : '☆ Favorite';
  $('#favBtn').classList.toggle('on', fav);
  for (const b of document.querySelectorAll('.rate [data-rate]')) {
    b.classList.toggle('on', !!b.dataset.rate && b.dataset.rate === (h?.rating || ''));
  }
  const sel = $('#sourceSel');
  sel.classList.toggle('hidden', ch.sources.length < 2);
  if (ch.sources.length > 1) {
    sel.innerHTML = ch.sources.map((s, i) => {
      const ss = sourceStatus(s);
      return `<option value="${esc(s.url)}"${s.url === src.url ? ' selected' : ''}>Source ${i + 1}: ${esc(s.name)} · ${esc(ss.label || 'Untested')}</option>`;
    }).join('');
  }
  const lines = [];
  if (ch.sources.length > 1) lines.push(`Showing details for source ${ch.sources.indexOf(src) + 1} of ${ch.sources.length}. If one fails, the next one is tried automatically.`);
  if (h?.plays) {
    lines.push(`Played ${h.plays}× · ${h.ok + h.slow} started · ${h.fails} failed · ${h.stalls} with heavy buffering` +
      (h.avgStartMs ? ` · average start ${fmtS(h.avgStartMs)}` : '') + ` · last ${ago(h.lastPlay)}`);
  }
  if (h?.lastResult === 'fail' && h.lastNote) lines.push(`Last problem: ${h.lastNote}`);
  if (h?.probe) lines.push(`Test ${ago(h.probe.at)}: ${fromProbe(h.probe).label}${h.probe.note ? ' · ' + h.probe.note : ''}`);
  if (src.hdr) lines.push('This source asks for a special User-Agent/Referer that browsers can’t send, so it may only work in VLC.');
  if (isMixed(src.url)) lines.push('Plain-HTTP stream: playing the HTTPS version, because browsers block plain HTTP on this page.');
  if (lines.length < 2 && !h) lines.push('No history yet.');
  $('#nowStats').innerHTML = lines.map(l => `<div>${esc(l)}</div>`).join('');
}

function setRating(r) {
  const url = currentSourceUrl();
  if (!url) return;
  const h = H(url);
  h.rating = r;
  saveH(h);
  toast(r ? 'Rating saved for this source' : 'Rating cleared');
}
const favRecord = ch => ({ key: ch.key, name: ch.name, logo: ch.logo, group: ch.group, sources: ch.sources, addedAt: Date.now() });
function toggleFav(ch) {
  if (S.favs.has(ch.key)) {
    S.favs.delete(ch.key);
    DB.del('favs', ch.key);
  } else {
    const f = favRecord(ch);
    S.favs.set(ch.key, f);
    DB.put('favs', f);
  }
  if (S.ui.status === 'fav') { rebuildGroups(); applyFilters(true); } else scheduleRender();
  renderNow();
}

/* =========================================================================
   Playlists
   ========================================================================= */
async function fetchPlaylist(url) {
  try {
    const r = await fetch(effectiveUrl(url), { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.text();
  } catch (e) {
    throw new Error(`Couldn’t download the playlist (${e.message}). The server may block browsers: download the .m3u file and upload it instead.`);
  }
}
function nameFromUrl(url) {
  try { return decodeURIComponent(new URL(url).pathname.split('/').pop() || new URL(url).hostname).replace(/\.m3u8?$/i, ''); }
  catch { return ''; }
}
function renderPlaylists() {
  const sel = $('#playlistSelect');
  sel.innerHTML = S.playlists.length
    ? S.playlists.map(p => `<option value="${p.id}"${p.id === S.ui.currentId ? ' selected' : ''}>${esc(p.name)} (${p.count})</option>`).join('')
    : '<option value="">No playlists yet</option>';
  const cur = S.playlists.find(p => p.id === S.ui.currentId);
  $('#refreshPlaylistBtn').disabled = !cur?.url;
  $('#deletePlaylistBtn').disabled = !cur;
}
// Install a channel list: lookup maps, favorites kept in sync with the newest sources.
function setChannels(chs) {
  S.channels = chs;
  S.byKey = new Map(chs.map(c => [c.key, c]));
  S.byUrl = new Map();
  for (const f of S.favs.values()) for (const s of f.sources || []) S.byUrl.set(s.url, S.byKey.get(f.key) || f);
  for (const c of chs) for (const s of c.sources) S.byUrl.set(s.url, c);
  for (const f of [...S.favs.values()]) {
    let ch = S.byKey.get(f.key);
    if (!ch && f.key.startsWith('u:')) ch = S.byUrl.get(f.key.slice(2)); // favorite saved by an older version
    if (!ch || !ch.sources) continue;
    if (ch.key !== f.key) { S.favs.delete(f.key); DB.del('favs', f.key); }
    if (ch.key !== f.key || JSON.stringify(ch.sources) !== JSON.stringify(f.sources)) {
      const nf = { ...favRecord(ch), addedAt: f.addedAt };
      S.favs.set(ch.key, nf);
      DB.put('favs', nf);
    }
  }
}
async function addPlaylist({ name, url, text }) {
  if (!text) text = await fetchPlaylist(url);
  const chs = buildChannels(text);
  if (!chs.length) throw new Error('No channels found in this playlist.');
  const id = 'p' + Date.now().toString(36);
  const meta = { id, name: name || nameFromUrl(url) || `Playlist ${S.playlists.length + 1}`, url: url || '',
                 count: chs.length, addedAt: Date.now(), updatedAt: Date.now() };
  await DB.put('kv', text, 'pl:' + id);
  S.playlists.push(meta);
  await DB.put('kv', S.playlists, 'playlists');
  if (S.ui.status === 'fav') S.ui.status = 'all';
  await selectPlaylist(id, chs);
  toast(`Added ${chs.length} channels`);
}
async function selectPlaylist(id, parsed) {
  S.ui.currentId = id;
  S.ui.group = '';
  saveUi();
  setChannels(!id ? [] : parsed || buildChannels((await DB.get('kv', 'pl:' + id)) || ''));
  renderPlaylists();
  $('#statusFilter').value = S.ui.status;
  $('#sortSel').value = S.ui.sort || '';
  rebuildGroups();
  applyFilters();
  backgroundRefresh(S.playlists.find(p => p.id === id));
}
async function savePlaylistText(p, text, chs) {
  await DB.put('kv', text, 'pl:' + p.id);
  p.count = chs.length;
  p.updatedAt = Date.now();
  await DB.put('kv', S.playlists, 'playlists');
}
async function refreshPlaylist() {
  const p = S.playlists.find(x => x.id === S.ui.currentId);
  if (!p?.url) return;
  try {
    const text = await fetchPlaylist(p.url);
    const chs = buildChannels(text);
    if (!chs.length) throw new Error('No channels found.');
    await savePlaylistText(p, text, chs);
    await selectPlaylist(p.id, chs);
    toast(`Playlist updated: ${chs.length} channels`);
  } catch (e) {
    toast(e.message);
  }
}
// Saved playlists from a URL go stale (iptv-org changes daily): quietly re-download after a day.
const refreshing = new Set();
async function backgroundRefresh(p) {
  if (!p?.url || refreshing.has(p.id) || Date.now() - (p.updatedAt || p.addedAt || 0) < REFRESH_AFTER) return;
  refreshing.add(p.id);
  try {
    const text = await fetchPlaylist(p.url);
    const chs = buildChannels(text);
    if (!chs.length) return;
    await savePlaylistText(p, text, chs);
    if (S.ui.currentId === p.id) {
      setChannels(chs);
      if (S.current) S.current = S.byKey.get(S.current.key) || S.current;
      renderPlaylists();
      rebuildGroups();
      applyFilters(true);
    }
    toast(`“${p.name}” updated: ${chs.length} channels`);
  } catch {
    /* offline or blocked: keep using the saved copy */
  } finally {
    refreshing.delete(p.id);
  }
}
async function deletePlaylist() {
  const p = S.playlists.find(x => x.id === S.ui.currentId);
  if (!p || !confirm(`Remove playlist “${p.name}”? Your favorites and ratings are kept.`)) return;
  await DB.del('kv', 'pl:' + p.id);
  S.playlists = S.playlists.filter(x => x !== p);
  await DB.put('kv', S.playlists, 'playlists');
  await selectPlaylist(S.playlists[0]?.id || null);
}

/* =========================================================================
   Backup / restore
   ========================================================================= */
async function exportData() {
  const data = {
    app: 'm3u-player', version: 2, exportedAt: new Date().toISOString(),
    settings: S.settings, favs: [...S.favs.values()], health: [...S.health.values()], playlists: [],
  };
  for (const p of S.playlists) data.playlists.push({ ...p, text: await DB.get('kv', 'pl:' + p.id) });
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `m3u-player-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
async function importData(file) {
  try {
    const data = JSON.parse(await file.text());
    if (data.app !== 'm3u-player') throw new Error('This is not an M3U Player backup.');
    if (data.settings) { S.settings = { ...DEFAULT_SETTINGS, ...data.settings }; await DB.put('kv', S.settings, 'settings'); }
    for (const old of data.favs || []) { const f = upgradeFav(old); S.favs.set(f.key, f); await DB.put('favs', f); }
    for (const h of data.health || []) { S.health.set(h.url, h); await DB.put('health', h); }
    for (const p of data.playlists || []) {
      if (S.playlists.some(x => x.id === p.id) || !p.text) continue;
      const { text, ...meta } = p;
      await DB.put('kv', text, 'pl:' + p.id);
      S.playlists.push(meta);
    }
    await DB.put('kv', S.playlists, 'playlists');
    await selectPlaylist(S.ui.currentId && S.playlists.some(p => p.id === S.ui.currentId) ? S.ui.currentId : S.playlists[0]?.id || null);
    toast('Backup imported');
  } catch (e) {
    toast('Import failed: ' + e.message);
  }
}
async function clearStats() {
  if (!confirm('Clear all test results and play history? Your ratings and favorites are kept.')) return;
  await DB.clear('health');
  const keep = [...S.health.values()].filter(h => h.rating);
  S.health.clear();
  S.hosts.clear();
  for (const old of keep) { const h = H(old.url); h.rating = old.rating; await DB.put('health', h); }
  applyFilters(true);
  renderNow();
  toast('Test history cleared');
}
async function eraseAll() {
  if (!confirm('Erase all playlists, favorites, ratings and settings from this browser?')) return;
  await Promise.all(['kv', 'health', 'favs'].map(s => DB.clear(s)));
  location.reload();
}

/* =========================================================================
   Wiring
   ========================================================================= */
let scrollIdle, searchTimer, hoverTimer;
function openAddDialog() {
  $('#addForm').reset();
  $('#addErr').textContent = '';
  $('#addDlg').showModal();
  loadIptvOrgChoices();
}
function openSettings() {
  const s = S.settings;
  $('#sSlow').value = s.slowStartSec;
  $('#sTimeout').value = s.timeoutSec;
  $('#sAutoSkip').checked = s.autoSkip;
  $('#sAutoTest').checked = s.autoTest;
  $('#sConc').value = s.concurrency;
  $('#setDlg').showModal();
}
const clamp = (v, lo, hi, d) => { v = Math.round(+v); return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d; };

function wire() {
  $('#list').addEventListener('scroll', () => {
    scheduleRender();
    clearTimeout(scrollIdle);
    scrollIdle = setTimeout(autoTestVisible, 600);
  });
  window.addEventListener('resize', scheduleRender);

  $('#listInner').addEventListener('click', e => {
    if (e.target.closest('[data-act="add"]')) return openAddDialog();
    const star = e.target.closest('[data-star]');
    if (star) { e.stopPropagation(); return toggleFav(S.filtered[+star.dataset.star]); }
    const row = e.target.closest('.ch');
    if (row) playChannel(S.filtered[+row.dataset.i]);
  });
  // Hovering a channel: get the player library and the stream's server connection ready.
  $('#listInner').addEventListener('pointerover', e => {
    const row = e.target.closest('.ch');
    if (!row) return;
    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => {
      const ch = S.filtered[+row.dataset.i];
      if (!ch) return;
      loadLib('hls').catch(() => {});
      preconnect(orderedSources(ch)[0].url);
    }, 120);
  });

  $('#search').addEventListener('input', e => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { S.ui.search = e.target.value; saveUi(); applyFilters(); }, 150);
  });
  $('#groupFilter').addEventListener('change', e => { S.ui.group = e.target.value; saveUi(); applyFilters(); });
  $('#statusFilter').addEventListener('change', e => { S.ui.status = e.target.value; saveUi(); rebuildGroups(); applyFilters(); });
  $('#sortSel').addEventListener('change', e => { S.ui.sort = e.target.value; saveUi(); applyFilters(); });

  $('#testBtn').addEventListener('click', () => {
    if (T.manual && (T.active || T.queue.length)) return stopTests();
    const urls = testUrlsFor(S.filtered);
    if (!urls.length) return toast(S.filtered.length ? 'Everything here was checked in the last 6 hours' : 'Nothing to test');
    if (urls.length > 1500 && !confirm(`Test ${urls.length} channels? This can take a while. Tip: pick a group or country first.`)) return;
    queueTests(urls, { manual: true });
  });
  $('#testOneBtn').addEventListener('click', () => {
    if (!S.current) return;
    queueTests(S.current.sources.map(s => s.url), { force: true, front: true });
    toast(S.current.sources.length > 1 ? `Testing all ${S.current.sources.length} sources…` : 'Testing…');
  });

  $('#playlistSelect').addEventListener('change', e => selectPlaylist(e.target.value));
  $('#addPlaylistBtn').addEventListener('click', openAddDialog);
  $('#refreshPlaylistBtn').addEventListener('click', refreshPlaylist);
  $('#deletePlaylistBtn').addEventListener('click', deletePlaylist);

  $('#addForm').addEventListener('submit', async e => {
    if (e.submitter?.value === 'cancel') return;
    e.preventDefault();
    const name = $('#plName').value.trim();
    const url = $('#plUrl').value.trim();
    const file = $('#plFile').files[0];
    let text = $('#plText').value.trim();
    const err = $('#addErr');
    err.textContent = '';
    if (!url && !file && !text) { err.textContent = 'Enter a URL, choose a file, or paste a playlist.'; return; }
    const btn = $('#addSubmit');
    btn.disabled = true;
    btn.textContent = 'Loading…';
    try {
      if (file) text = await file.text();
      await addPlaylist({ name: name || (file ? file.name.replace(/\.(m3u8?|txt)$/i, '') : ''), url: file || text ? '' : url, text });
      $('#addDlg').close();
    } catch (ex) {
      err.textContent = ex.message;
    } finally {
      btn.disabled = false;
      btn.textContent = 'Add';
    }
  });

  $('#plPreset').addEventListener('change', e => {
    const opt = e.target.selectedOptions[0];
    if (!opt.value) return;
    $('#plUrl').value = opt.value;
    $('#plName').value = 'iptv-org: ' + opt.textContent.trim();
  });

  $('#settingsBtn').addEventListener('click', openSettings);
  $('#setForm').addEventListener('submit', e => {
    if (e.submitter?.value !== 'save') return;
    const d = DEFAULT_SETTINGS;
    S.settings = {
      slowStartSec: clamp($('#sSlow').value, 1, 60, d.slowStartSec),
      timeoutSec: clamp($('#sTimeout').value, 3, 120, d.timeoutSec),
      autoSkip: $('#sAutoSkip').checked,
      autoTest: $('#sAutoTest').checked,
      concurrency: clamp($('#sConc').value, 1, 16, d.concurrency),
    };
    DB.put('kv', S.settings, 'settings');
    toast('Settings saved');
  });
  $('#exportBtn').addEventListener('click', exportData);
  $('#importFile').addEventListener('change', e => { if (e.target.files[0]) importData(e.target.files[0]); e.target.value = ''; });
  $('#clearStatsBtn').addEventListener('click', clearStats);
  $('#clearAllBtn').addEventListener('click', eraseAll);

  $('#favBtn').addEventListener('click', () => S.current && toggleFav(S.current));
  $('#prevBtn').addEventListener('click', () => step(-1));
  $('#nextBtn').addEventListener('click', () => step(1));
  $('#sourceSel').addEventListener('change', e => S.current && playChannel(S.current, e.target.value));
  for (const b of document.querySelectorAll('[data-rate]')) b.addEventListener('click', () => setRating(b.dataset.rate));
  $('#copyBtn').addEventListener('click', copyLink);

  $('#overlay').addEventListener('click', e => {
    const a = e.target.closest('[data-act]')?.dataset.act;
    if (!a) return;
    if (a === 'next') step(1, true);
    else if (a === 'retry' && S.current) playChannel(S.current);
    else if (a === 'copy') copyLink();
    else if (a === 'switch') { if (!nextSource()) toast('No other sources for this channel'); }
    else if (a === 'wait') showOverlay('<div class="spinner"></div>Still waiting…', [['next', 'Next channel']]);
    else if (a === 'broken') { setRating('broken'); step(1, true); }
    else if (a === 'rate-buffers') { setRating('buffers'); hideOverlay(); }
  });

  document.addEventListener('keydown', e => {
    if (e.target.closest('input, textarea, select, dialog') || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'ArrowDown' || e.key === 'n') { e.preventDefault(); step(1); }
    else if (e.key === 'ArrowUp' || e.key === 'p') { e.preventDefault(); step(-1); }
    else if (e.key === 'f' && S.current) toggleFav(S.current);
  });
}
function copyLink() {
  const url = currentSourceUrl();
  if (!url) return;
  navigator.clipboard.writeText(url).then(() => toast('Link copied'), () => prompt('Stream link:', url));
}

async function init() {
  wire();
  const [pls, settings, ui, health, favs] = await Promise.all([
    DB.get('kv', 'playlists'), DB.get('kv', 'settings'), DB.get('kv', 'ui'), DB.all('health'), DB.all('favs'),
  ]);
  S.playlists = pls || [];
  S.settings = { ...DEFAULT_SETTINGS, ...(settings || {}) };
  S.ui = { ...S.ui, ...(ui || {}) };
  const recent = Date.now() - 24 * 3600e3;
  for (const h of health || []) {
    S.health.set(h.url, h);
    if (h.probe && !h.probe.inferred && h.probe.at > recent) noteHost(h.url, h.probe);
  }
  for (const f of favs || []) S.favs.set(f.key, f);
  $('#search').value = S.ui.search;

  const startId = S.playlists.some(p => p.id === S.ui.currentId) ? S.ui.currentId : S.playlists[0]?.id || null;
  await selectPlaylist(startId);

  // Show (but don't autoplay) the channel you watched last.
  const last = S.byKey.get(S.ui.lastKey) || S.favs.get(S.ui.lastKey) || (S.ui.lastUrl && S.byUrl.get(S.ui.lastUrl));
  if (last?.sources) { S.current = last; scrollToCurrent(); scheduleRender(); }
  renderNow();

  // Shortcut: ?m3u=<playlist url> adds that playlist (once).
  const qp = new URLSearchParams(location.search).get('m3u');
  if (qp && !S.playlists.some(p => p.url === qp)) {
    loadWithSpinner({ url: qp });
  } else if (!S.playlists.length && !S.ui.seeded) {
    // First visit: preload the iptv-org list. Only once, so removing it sticks.
    S.ui.seeded = true;
    saveUi();
    loadWithSpinner(DEFAULT_PLAYLIST);
  }
  // Fetch the HLS library in the background once the page is up, so the first click is quick.
  setTimeout(() => loadLib('hls').catch(() => {}), 1500);
}
async function loadWithSpinner(pl) {
  S.loading = `Loading ${pl.name || 'playlist'}…`;
  renderList();
  try {
    await addPlaylist(pl);
  } catch (e) {
    toast(e.message);
  } finally {
    S.loading = '';
    renderList();
  }
}

/* Quick-pick of iptv-org lists in the Add dialog (all channels, or one country). */
let countriesLoaded = false;
async function loadIptvOrgChoices() {
  if (countriesLoaded) return;
  countriesLoaded = true;
  try {
    const list = await (await fetch(IPTV_ORG.replace('/iptv/', '/api/') + 'countries.json')).json();
    list.sort((a, b) => a.name.localeCompare(b.name));
    $('#plPreset').insertAdjacentHTML('beforeend', '<optgroup label="By country">' +
      list.map(c => `<option value="${IPTV_ORG}countries/${esc(c.code.toLowerCase())}.m3u">${esc(c.flag || '')} ${esc(c.name)}</option>`).join('') +
      '</optgroup>');
  } catch {
    countriesLoaded = false; // try again next time the dialog opens
  }
}
init();

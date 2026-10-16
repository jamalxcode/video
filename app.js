'use strict';

/* =========================================================================
   Storage — IndexedDB, so everything stays in this browser only.
   Stores: kv (settings, ui, playlist list, playlist texts),
           health (per-stream test + play history, keyed by URL),
           favs (favorite channels, keyed by URL)
   ========================================================================= */
const DB = (() => {
  let dbp;
  const open = () => dbp || (dbp = new Promise((res, rej) => {
    const r = indexedDB.open('m3u-player', 1);
    r.onupgradeneeded = () => {
      const db = r.result;
      db.createObjectStore('kv');
      db.createObjectStore('health', { keyPath: 'url' });
      db.createObjectStore('favs', { keyPath: 'url' });
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

/* =========================================================================
   Helpers
   ========================================================================= */
const $ = s => document.querySelector(s);
const PAGE_HTTPS = location.protocol === 'https:';
// Browsers refuse plain-http media on an https page, so try the https version instead.
const isMixed = url => PAGE_HTTPS && /^http:/i.test(url);
const effectiveUrl = url => (isMixed(url) ? url.replace(/^http:/i, 'https:') : url);
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

/* =========================================================================
   State
   ========================================================================= */
const DEFAULT_SETTINGS = { slowStartSec: 6, timeoutSec: 15, autoSkip: false, autoTest: true, concurrency: 6 };
// Loaded automatically for first-time visitors (https://github.com/iptv-org/iptv).
const IPTV_ORG = 'https://iptv-org.github.io/iptv/';
const DEFAULT_PLAYLIST = { name: 'iptv-org (all channels)', url: IPTV_ORG + 'index.m3u' };
const S = {
  playlists: [],        // [{ id, name, url, count, addedAt }]
  channels: [],         // channels of the selected playlist
  filtered: [],         // what the list currently shows
  health: new Map(),    // url -> health record
  favs: new Map(),      // url -> channel
  settings: { ...DEFAULT_SETTINGS },
  ui: { currentId: null, search: '', group: '', status: 'all', lastUrl: '' },
  current: null,
  loading: '',          // message shown in the list while a playlist downloads
};
const saveUi = () => DB.put('kv', { ...S.ui }, 'ui');

/* =========================================================================
   M3U parsing
   ========================================================================= */
function titleComma(s) {
  let q = false;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '"') q = !q;
    else if (s[i] === ',' && !q) return i;
  }
  return s.length;
}
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
      };
    } else if (/^#EXTGRP:/i.test(line)) {
      if (cur && !cur.group) cur.group = line.slice(8).trim();
    } else if (!line.startsWith('#')) {
      const url = line.split('|')[0].trim(); // strip Kodi-style "|User-Agent=…"
      if (!/^(https?|rtmp|rtsp|udp):\/\//i.test(url) && !url.includes('/')) { cur = null; continue; }
      out.push({
        name: cur?.name || url.split('/').pop() || 'Unnamed',
        logo: cur?.logo || '',
        group: cur?.group || 'Ungrouped',
        url,
      });
      cur = null;
    }
  }
  return out;
}

/* =========================================================================
   Health: what we know about each stream, and the badge it gets
   ========================================================================= */
function H(url) {
  let h = S.health.get(url);
  if (!h) {
    h = { url, plays: 0, ok: 0, slow: 0, fails: 0, stalls: 0, avgStartMs: 0, lastStartMs: 0,
          lastResult: '', lastNote: '', lastPlay: 0, probe: null, rating: '' };
    S.health.set(url, h);
  }
  return h;
}
function saveH(h) {
  DB.put('health', h);
  scheduleRender();
  if (S.current && S.current.url === h.url) renderNow();
}
const mk = (cls, label, tip) => ({ cls, label, tip });

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
function statusOf(url) {
  const h = S.health.get(url);
  if (h?.rating === 'good') return mk('good', 'Smooth ★', 'You rated this channel smooth');
  if (h?.rating === 'buffers') return mk('warn', 'Buffers ★', 'You rated this channel as buffering');
  if (h?.rating === 'broken') return mk('bad', 'Broken ★', 'You rated this channel broken');
  const hist = h?.lastPlay ? fromHistory(h) : null;
  const pr = h?.probe ? fromProbe(h.probe) : null;
  if (hist && pr) return h.lastPlay >= h.probe.at ? hist : pr; // newest evidence wins
  if (hist || pr) return hist || pr;
  if (isMixed(url)) return mk('untested', 'HTTP', 'Plain-HTTP stream: browsers may block it on this HTTPS page');
  return mk('untested', '', 'Not tested yet');
}
const isBadCls = cls => cls === 'bad' || cls === 'blocked';

/* =========================================================================
   Stream tester (runs in the browser; limited by what servers allow)
   ========================================================================= */
async function readFirst(res, maxBytes, maxMs) {
  const reader = res.body.getReader();
  const chunks = [];
  let bytes = 0;
  const t0 = performance.now();
  try {
    while (bytes < maxBytes && performance.now() - t0 < maxMs) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      bytes += value.length;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  const all = new Uint8Array(bytes);
  let o = 0;
  for (const c of chunks) { all.set(c, o); o += c.length; }
  return { data: all, ms: performance.now() - t0 };
}

async function probe(url) {
  const target = effectiveUrl(url);
  const base = { at: Date.now() };
  const t0 = performance.now();
  let r;
  try {
    r = await timed(target, 12000);
  } catch (e) {
    if (isTimeout(e)) return { ...base, status: 'dead', note: 'No response within 12s' };
    // Network error or CORS block: check whether the server answers at all.
    try {
      const t1 = performance.now();
      const r2 = await timed(target, 8000, { mode: 'no-cors' });
      r2.abort();
      return { ...base, status: 'blocked', ms: Math.round(performance.now() - t1),
               note: 'Server is online but blocks web players (CORS), so it usually won’t play in a browser (Safari sometimes can)' };
    } catch (e2) {
      if (target !== url) return { ...base, status: 'blocked', note: 'HTTP-only stream: browsers block it on an HTTPS page' };
      return { ...base, status: 'dead', note: 'Server not reachable' };
    }
  }
  base.ms = Math.round(performance.now() - t0);
  try {
    if (!r.res.ok) { r.abort(); return { ...base, status: 'dead', note: `Server error (HTTP ${r.res.status})` }; }
    const first = await readFirst(r.res, 2 * 1024 * 1024, 4000);
    r.abort();
    const head = new TextDecoder().decode(first.data.slice(0, 32)).replace(/^﻿/, '');
    if (head.startsWith('#EXTM3U')) {
      return await probeHls(new TextDecoder().decode(first.data), r.res.url || target, base);
    }
    // Direct stream (MPEG-TS, FLV, MP4…): measure raw download speed.
    const sec = Math.max(first.ms, 1) / 1000;
    const mbps = (first.data.length * 8) / sec / 1e6;
    if (first.data.length < 64 * 1024) return { ...base, status: 'slow', note: `Responds in ${base.ms} ms but sends almost no data` };
    const status = mbps >= 3 && base.ms < 4000 ? 'ok' : 'slow';
    return { ...base, status, mbps: +mbps.toFixed(1), note: `Responds in ${base.ms} ms, downloads at ${mbps.toFixed(1)} Mbit/s` };
  } catch (e) {
    r.abort();
    if (isTimeout(e)) return { ...base, status: 'slow', note: 'Responded, then stalled while downloading' };
    return { ...base, status: 'dead', note: String(e.message || e) };
  }
}

async function probeHls(text, baseUrl, base) {
  let lines = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  if (lines.some(l => l.startsWith('#EXT-X-STREAM-INF'))) {
    // Master playlist: check the lowest quality, since players start there and adapt.
    let uri = null, best = Infinity;
    lines.forEach((l, i) => {
      if (!l.startsWith('#EXT-X-STREAM-INF')) return;
      const bw = +(l.match(/[:,]BANDWIDTH=(\d+)/) || [])[1] || Infinity;
      const u = lines.slice(i + 1).find(x => !x.startsWith('#'));
      if (u && (uri === null || bw < best)) { uri = u; best = bw; }
    });
    if (!uri) return { ...base, status: 'dead', note: 'Playlist lists no streams' };
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
  const segUrl = new URL(seg.u, baseUrl).href;
  const t0 = performance.now();
  let r;
  try {
    r = await timed(segUrl, Math.max(12000, seg.d * 3000));
  } catch (e) {
    if (isTimeout(e)) return { ...base, status: 'slow', note: 'Video segments download too slowly' };
    return { ...base, status: 'blocked', note: 'Video segments are blocked for web players (CORS)' };
  }
  try {
    if (!r.res.ok) { r.abort(); return { ...base, status: 'dead', note: `Video segments missing (HTTP ${r.res.status})` }; }
    await r.res.arrayBuffer();
    r.abort();
  } catch (e) {
    r.abort();
    return { ...base, status: 'slow', note: 'Video segment download stalled' };
  }
  const sec = Math.max(performance.now() - t0, 1) / 1000;
  const ratio = seg.d ? seg.d / sec : 0;
  let status = 'ok';
  let note = `Responds in ${base.ms} ms, video downloads ${ratio.toFixed(1)}× faster than real time`;
  if (ratio && ratio < 1) { status = 'slow'; note = `Video downloads slower than real time (${ratio.toFixed(1)}×), so it will buffer`; }
  else if ((ratio && ratio < 1.6) || base.ms > 4000) { status = 'slow'; }
  return { ...base, status, ratio: +ratio.toFixed(1), note };
}

const T = { queue: [], queued: new Set(), active: 0, done: 0, total: 0, manual: false };
function queueTests(urls, manual = false) {
  if (manual) { T.queue = []; T.queued.clear(); T.done = 0; T.total = T.active; T.manual = true; }
  for (const u of urls) {
    if (T.queued.has(u)) continue;
    T.queued.add(u);
    T.queue.push(u);
    T.total++;
  }
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
function pump() {
  while (T.active < S.settings.concurrency && T.queue.length) {
    const url = T.queue.shift();
    T.active++;
    probe(url)
      .catch(e => ({ at: Date.now(), status: 'dead', note: String(e.message || e) }))
      .then(p => { const h = H(url); h.probe = p; saveH(h); })
      .finally(() => {
        T.active--; T.done++; T.queued.delete(url);
        if (!T.active && !T.queue.length) { T.manual = false; T.done = T.total = 0; }
        updateTestUi();
        pump();
      });
  }
}
function updateTestUi() {
  const busy = T.active > 0 || T.queue.length > 0;
  $('#testBtn').textContent = T.manual && busy ? 'Stop testing' : 'Test channels';
  $('#testProgress').textContent = busy ? `Testing ${T.done}/${T.total}…` : '';
}
function autoTestVisible() {
  if (!S.settings.autoTest) return;
  const list = $('#list');
  const start = Math.floor(list.scrollTop / ROW);
  const end = Math.min(S.filtered.length, Math.ceil((list.scrollTop + listHeight()) / ROW));
  const stale = Date.now() - 6 * 3600e3;
  const urls = [];
  for (let i = start; i < end; i++) {
    const h = S.health.get(S.filtered[i].url);
    const last = Math.max(h?.probe?.at || 0, h?.lastPlay || 0);
    if (!h?.rating && last < stale) urls.push(S.filtered[i].url);
  }
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
    const st = statusOf(ch.url);
    const fav = S.favs.has(ch.url);
    const active = S.current && S.current.url === ch.url;
    html += `<div class="ch${active ? ' active' : ''}" data-i="${i}" style="top:${i * ROW}px" title="${esc(st.tip)}">
      <div class="logo">${ch.logo ? `<img src="${esc(ch.logo)}" loading="lazy" referrerpolicy="no-referrer" alt="" onerror="this.remove()">` : '▶'}</div>
      <div class="info"><div class="name">${esc(ch.name)}</div><div class="grp">${esc(groupLabel(ch))}</div></div>
      <span class="badge ${st.cls}"><i></i>${esc(st.label)}</span>
      <button class="star${fav ? ' on' : ''}" data-star="${i}" title="${fav ? 'Remove from' : 'Add to'} favorites">${fav ? '★' : '☆'}</button>
    </div>`;
  }
  inner.innerHTML = html;
}
// A channel can sit in several groups, written "News;Sports" (iptv-org does this).
const groupsOf = ch => ch.group.split(';').map(g => g.trim()).filter(Boolean);
const groupLabel = ch => groupsOf(ch).join(', ');
function passStatus(ch, f) {
  if (f === 'all' || f === 'fav') return true;
  const cls = statusOf(ch.url).cls;
  if (f === 'good') return cls === 'good';
  if (f === 'hideBad') return !isBadCls(cls);
  if (f === 'untested') return cls === 'untested';
  return true;
}
function sourceChannels() {
  return S.ui.status === 'fav'
    ? [...S.favs.values()].sort((a, b) => a.name.localeCompare(b.name))
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
  S.filtered = sourceChannels().filter(ch =>
    (!q || ch.name.toLowerCase().includes(q) || ch.group.toLowerCase().includes(q)) &&
    (!g || groupsOf(ch).includes(g)) && passStatus(ch, f));
  const total = sourceChannels().length;
  $('#count').textContent = S.filtered.length === total ? `${total} channels` : `${S.filtered.length} of ${total}`;
  if (!keepScroll) $('#list').scrollTop = 0;
  renderList();
  clearTimeout(scrollIdle);
  scrollIdle = setTimeout(autoTestVisible, 400);
}
function scrollToCurrent() {
  if (!S.current) return;
  const i = S.filtered.findIndex(c => c.url === S.current.url);
  if (i < 0) return;
  const list = $('#list');
  const y = i * ROW;
  if (y < list.scrollTop || y + ROW > list.scrollTop + listHeight()) {
    list.scrollTop = y - listHeight() / 2 + ROW / 2;
  }
}

/* =========================================================================
   Playback: hls.js for HLS, mpegts.js for raw TS/FLV, the browser for the rest.
   Every play is measured (start time, failures, buffering) and remembered.
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
// URL has no telling extension: peek at the first bytes to see what it is.
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

async function playChannel(ch) {
  leaveSession();
  teardown();
  const token = ++playToken;
  S.current = ch;
  S.ui.lastUrl = ch.url;
  saveUi();
  renderNow();
  scheduleRender();
  scrollToCurrent();
  showOverlay('<div class="spinner"></div>Loading…');
  session = { url: ch.url, t0: performance.now(), started: false, failed: false, recorded: false, stalls: 0, token };
  clearTimeout(startTimer);
  startTimer = setTimeout(() => onTimeout(token), S.settings.timeoutSec * 1000);
  const url = effectiveUrl(ch.url);
  const kind = kindOf(url) || await sniff(url);
  if (token !== playToken) return;
  startEngine(kind, url, token);
}

function startEngine(kind, url, token) {
  const fail = msg => { if (token === playToken) onPlayFail(msg); };
  if (kind === 'hls') {
    if (window.Hls && Hls.isSupported()) {
      engine = 'hls';
      hls = new Hls({ enableWorker: true, manifestLoadingTimeOut: 10000, levelLoadingTimeOut: 10000, fragLoadingTimeOut: 20000 });
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

function onTimeout(token) {
  if (token !== playToken || !session || session.started || session.failed) return;
  if (S.settings.autoSkip) return onPlayFail(`Didn’t start within ${S.settings.timeoutSec}s`);
  showOverlay(`<b>⏳ Still loading after ${S.settings.timeoutSec}s</b><div class="muted">This channel is slow or offline right now.</div>`,
    [['wait', 'Keep waiting'], ['next', 'Next channel'], ['broken', 'Mark broken & skip']]);
}

function onPlayFail(msg) {
  if (!session || session.failed) return;
  const s = session;
  s.failed = true;
  clearTimeout(startTimer);
  const h = H(s.url);
  if (!s.started) h.plays++;
  h.fails++;
  h.lastResult = 'fail';
  h.lastNote = msg;
  h.lastPlay = Date.now();
  s.recorded = true;
  saveH(h);
  teardown();
  if (S.settings.autoSkip && !s.started) {
    showOverlay(`✖ ${esc(msg)}<div class="muted">Skipping to the next working channel…</div>`);
    setTimeout(() => { if (s.token === playToken) step(1, true); }, 1500);
    return;
  }
  showOverlay(`<b>✖ Couldn’t play this channel</b><div class="muted">${esc(msg)}</div>`,
    [['next', 'Next channel'], ['retry', 'Retry'], ['copy', 'Copy link for VLC']]);
}

// Leaving a channel that never started counts as a failure if we waited long enough.
function leaveSession() {
  if (!session) return;
  clearTimeout(startTimer);
  const waited = performance.now() - session.t0;
  if (!session.started && !session.recorded && waited >= S.settings.slowStartSec * 1000) {
    const h = H(session.url);
    h.plays++;
    h.fails++;
    h.lastResult = 'fail';
    h.lastNote = `didn’t start after ${Math.round(waited / 1000)}s`;
    h.lastPlay = Date.now();
    saveH(h);
  }
  session = null;
}

video.addEventListener('playing', () => {
  if (!session || session.token !== playToken) return;
  hideOverlay();
  if (session.started) return;
  session.started = true;
  clearTimeout(startTimer);
  const ms = performance.now() - session.t0;
  const h = H(session.url);
  const n = h.ok + h.slow;
  h.avgStartMs = Math.round((h.avgStartMs * n + ms) / (n + 1));
  h.lastStartMs = Math.round(ms);
  h.plays++;
  h.lastPlay = Date.now();
  if (ms > S.settings.slowStartSec * 1000) { h.slow++; h.lastResult = 'slow'; }
  else { h.ok++; h.lastResult = 'ok'; }
  session.recorded = true;
  saveH(h);
});
video.addEventListener('waiting', () => {
  if (!session?.started || session.token !== playToken || session.failed) return;
  session.stalls++;
  if (session.stalls === 3) {
    const h = H(session.url);
    h.stalls++;
    h.lastResult = 'stall';
    h.lastPlay = Date.now();
    saveH(h);
  }
  if (session.stalls >= 3) {
    showOverlay('<div class="spinner"></div>Buffering again… this channel keeps stalling.',
      [['next', 'Next channel'], ['rate-buffers', 'Rate “Buffers”']]);
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
  let i = S.current ? list.findIndex(c => c.url === S.current.url) : -1;
  if (i < 0 && dir < 0) i = 0;
  for (let n = 0; n < list.length; n++) {
    i = (i + dir + list.length) % list.length;
    if (!skipBad || !isBadCls(statusOf(list[i].url).cls)) return playChannel(list[i]);
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
  const hasCh = !!ch;
  for (const b of document.querySelectorAll('.rate button, #favBtn, #prevBtn, #nextBtn')) b.disabled = !hasCh;
  if (!ch) return;
  const st = statusOf(ch.url);
  const h = S.health.get(ch.url);
  $('#nowName').textContent = ch.name;
  $('#nowMeta').innerHTML = `${esc(groupLabel(ch))} ·<span class="badge ${st.cls}"><i></i>${esc(st.label || 'Untested')}</span>`;
  const logo = $('#nowLogo');
  logo.classList.toggle('hidden', !ch.logo);
  if (ch.logo) { logo.src = ch.logo; logo.onerror = () => logo.classList.add('hidden'); }
  const fav = S.favs.has(ch.url);
  $('#favBtn').textContent = fav ? '★ Favorite' : '☆ Favorite';
  $('#favBtn').classList.toggle('on', fav);
  for (const b of document.querySelectorAll('.rate [data-rate]')) {
    b.classList.toggle('on', !!b.dataset.rate && b.dataset.rate === (h?.rating || ''));
  }
  const lines = [];
  if (h?.plays) {
    lines.push(`Played ${h.plays}× · ${h.ok + h.slow} started · ${h.fails} failed · ${h.stalls} with heavy buffering` +
      (h.avgStartMs ? ` · average start ${fmtS(h.avgStartMs)}` : '') + ` · last ${ago(h.lastPlay)}`);
  }
  if (h?.lastResult === 'fail' && h.lastNote) lines.push(`Last problem: ${h.lastNote}`);
  if (h?.probe) lines.push(`Test ${ago(h.probe.at)}: ${fromProbe(h.probe).label}${h.probe.note ? ' · ' + h.probe.note : ''}`);
  if (isMixed(ch.url)) lines.push('Plain-HTTP stream: playing the HTTPS version, because browsers block plain HTTP on this page.');
  if (!lines.length) lines.push('No history yet for this channel.');
  $('#nowStats').innerHTML = lines.map(l => `<div>${esc(l)}</div>`).join('');
}

function setRating(r) {
  if (!S.current) return;
  const h = H(S.current.url);
  h.rating = r;
  saveH(h);
  toast(r ? 'Rating saved' : 'Rating cleared');
}
function toggleFav(ch) {
  if (S.favs.has(ch.url)) {
    S.favs.delete(ch.url);
    DB.del('favs', ch.url);
  } else {
    const f = { url: ch.url, name: ch.name, logo: ch.logo, group: ch.group, addedAt: Date.now() };
    S.favs.set(ch.url, f);
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
async function addPlaylist({ name, url, text }) {
  if (!text) text = await fetchPlaylist(url);
  const chs = parseM3U(text);
  if (!chs.length) throw new Error('No channels found in this playlist.');
  const id = 'p' + Date.now().toString(36);
  const meta = { id, name: name || nameFromUrl(url) || `Playlist ${S.playlists.length + 1}`, url: url || '', count: chs.length, addedAt: Date.now() };
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
  if (!id) { S.channels = []; }
  else S.channels = parsed || parseM3U((await DB.get('kv', 'pl:' + id)) || '');
  renderPlaylists();
  $('#statusFilter').value = S.ui.status;
  rebuildGroups();
  applyFilters();
}
async function refreshPlaylist() {
  const p = S.playlists.find(x => x.id === S.ui.currentId);
  if (!p?.url) return;
  try {
    const text = await fetchPlaylist(p.url);
    const chs = parseM3U(text);
    if (!chs.length) throw new Error('No channels found.');
    await DB.put('kv', text, 'pl:' + p.id);
    p.count = chs.length;
    await DB.put('kv', S.playlists, 'playlists');
    await selectPlaylist(p.id, chs);
    toast(`Playlist updated: ${chs.length} channels`);
  } catch (e) {
    toast(e.message);
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
    app: 'm3u-player', version: 1, exportedAt: new Date().toISOString(),
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
    for (const f of data.favs || []) { S.favs.set(f.url, f); await DB.put('favs', f); }
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
let scrollIdle, searchTimer;
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

  $('#search').addEventListener('input', e => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { S.ui.search = e.target.value; saveUi(); applyFilters(); }, 150);
  });
  $('#groupFilter').addEventListener('change', e => { S.ui.group = e.target.value; saveUi(); applyFilters(); });
  $('#statusFilter').addEventListener('change', e => { S.ui.status = e.target.value; saveUi(); rebuildGroups(); applyFilters(); });

  $('#testBtn').addEventListener('click', () => {
    if (T.manual && (T.active || T.queue.length)) return stopTests();
    const urls = S.filtered.map(c => c.url);
    if (!urls.length) return;
    if (urls.length > 1500 && !confirm(`Test all ${urls.length} channels? This can take a while. Tip: pick a group first.`)) return;
    queueTests(urls, true);
  });
  $('#testOneBtn').addEventListener('click', () => { if (S.current) { queueTests([S.current.url]); toast('Testing…'); } });

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
  for (const b of document.querySelectorAll('[data-rate]')) b.addEventListener('click', () => setRating(b.dataset.rate));
  $('#copyBtn').addEventListener('click', copyLink);

  $('#overlay').addEventListener('click', e => {
    const a = e.target.closest('[data-act]')?.dataset.act;
    if (!a) return;
    if (a === 'next') step(1, true);
    else if (a === 'retry' && S.current) playChannel(S.current);
    else if (a === 'copy') copyLink();
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
  if (!S.current) return;
  navigator.clipboard.writeText(S.current.url).then(() => toast('Link copied'), () => prompt('Stream link:', S.current.url));
}

async function init() {
  wire();
  const [pls, settings, ui, health, favs] = await Promise.all([
    DB.get('kv', 'playlists'), DB.get('kv', 'settings'), DB.get('kv', 'ui'), DB.all('health'), DB.all('favs'),
  ]);
  S.playlists = pls || [];
  S.settings = { ...DEFAULT_SETTINGS, ...(settings || {}) };
  S.ui = { ...S.ui, ...(ui || {}) };
  for (const h of health || []) S.health.set(h.url, h);
  for (const f of favs || []) S.favs.set(f.url, f);
  $('#search').value = S.ui.search;

  const startId = S.playlists.some(p => p.id === S.ui.currentId) ? S.ui.currentId : S.playlists[0]?.id || null;
  await selectPlaylist(startId);

  // Show (but don't autoplay) the channel you watched last.
  const last = S.ui.lastUrl && (S.channels.find(c => c.url === S.ui.lastUrl) || S.favs.get(S.ui.lastUrl));
  if (last) { S.current = last; scrollToCurrent(); scheduleRender(); }
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

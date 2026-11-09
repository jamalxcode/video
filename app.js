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
  mpegts: 'https://cdn.jsdelivr.net/npm/mpegts.js@1.7.3/dist/mpegts.js', // the package ships no .min.js; the CDN's own minified copy can't be hash-checked
};
// The browser checks each file against its hash before running it, so a changed or tampered copy is refused.
const LIB_HASH = {
  hls: 'sha384-9v3HcdYrO3D+OPDTjZ40RXocgE4GtXVCd3/mCS62JsM93JXgI1afJVuwjFvsu6ni',
  mpegts: 'sha384-gWBszQzp4KdKY3PNUrFbTuvAcChcUSMKpSrt/OjDS3qe16Ef4OZSfP5E/+KcPueP',
};
const libLoads = {};
function loadLib(name) {
  return libLoads[name] || (libLoads[name] = new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = LIBS[name];
    if (LIB_HASH[name]) { s.integrity = LIB_HASH[name]; s.crossOrigin = 'anonymous'; }
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
const DEFAULT_SETTINGS = { slowStartSec: 6, timeoutSec: 15, autoSkip: false, autoTest: true, concurrency: 6, fx: true };
// Loaded automatically for first-time visitors (https://github.com/iptv-org/iptv).
const IPTV_ORG = 'https://iptv-org.github.io/iptv/';
// Free-TV (https://github.com/Free-TV/IPTV): a hand-picked list of channels that are free to watch,
// about 2,000 of them, many not in iptv-org (Italian, Greek, Hungarian, Pluto TV and more).
const FREE_TV = 'https://raw.githubusercontent.com/Free-TV/IPTV/master/playlist.m3u8';
// A playlist's url can hold several lists separated by spaces; they're downloaded together and
// combined, so a channel found in both becomes one channel with backup sources.
const DEFAULT_PLAYLIST = { name: 'All channels (iptv-org + Free-TV)', url: IPTV_ORG + 'index.m3u ' + FREE_TV };
// What the default list was before Free-TV was added; saved copies are upgraded on start.
const OLD_DEFAULT = { name: 'iptv-org (all channels)', url: IPTV_ORG + 'index.m3u' };
const isDefaultList = url => url === DEFAULT_PLAYLIST.url || url === OLD_DEFAULT.url;
const splitUrls = url => (url || '').split(/\s+/).filter(Boolean);
// iptv-org.github.io is blocked on some networks (the connection is reset). The same files are
// published from the repos' gh-pages branches on these hosts, tried in this order; the first mirror
// is this site's own Cloudflare Worker (mirror/mirror.js), which fetches from iptv-org for you.
const IPTV_RE = /^https:\/\/iptv-org\.github\.io\/(iptv|api)\//i;
const IPTV_MIRRORS = [
  'https://video-mirror.jamal-akuna-matata.workers.dev/$1/', // this site's own copy on Cloudflare (cached a few hours)
  'https://raw.githubusercontent.com/iptv-org/$1/gh-pages/',
  'https://cdn.jsdelivr.net/gh/iptv-org/$1@gh-pages/',
  'https://fastly.jsdelivr.net/gh/iptv-org/$1@gh-pages/',
  'https://gcore.jsdelivr.net/gh/iptv-org/$1@gh-pages/',
  'https://rawcdn.githack.com/iptv-org/$1/gh-pages/',
];
// Any other file on raw.githubusercontent.com (Free-TV and the like) has the same CDN copies.
const RAW_RE = /^https:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\//i;
const RAW_MIRRORS = [
  'https://cdn.jsdelivr.net/gh/$1/$2@$3/',
  'https://fastly.jsdelivr.net/gh/$1/$2@$3/',
  'https://gcore.jsdelivr.net/gh/$1/$2@$3/',
  'https://rawcdn.githack.com/$1/$2/$3/',
];
// Free-TV's repo is over jsDelivr's 50 MB limit, so jsDelivr can't serve it. This site keeps its own
// copy instead (lists/free-tv.m3u8, refreshed daily by .github/workflows/free-tv.yml): same site,
// so it loads wherever the player itself loads. It's tried first; GitHub is the fallback.
const FREE_TV_COPY = new URL('lists/free-tv.m3u8', location.href).href;
const mirrorUrls = url => (IPTV_RE.test(url) ? [url, ...IPTV_MIRRORS.map(to => url.replace(IPTV_RE, to))]
  : url === FREE_TV ? [FREE_TV_COPY, url, url.replace(RAW_RE, RAW_MIRRORS[3])]
  : RAW_RE.test(url) ? [url, ...RAW_MIRRORS.map(to => url.replace(RAW_RE, to))] : [url]);
const MIRROR_STAGGER = 3000; // start the next mirror after this long without an answer
// fetch() over the mirrors of an iptv-org URL: the first one to answer OK wins, the rest are
// cancelled. A host that fails at once hands over immediately; one that hangs is overtaken.
function fetchAny(url, opts = {}) {
  const urls = mirrorUrls(url);
  return new Promise((resolve, reject) => {
    const ctls = [];
    let next = 0, pending = 0, done = false, lastErr;
    const settle = (ok, v) => {
      if (done) return;
      done = true;
      ok ? resolve(v) : reject(v);
    };
    const start = () => {
      if (done || next >= urls.length) return;
      const u = urls[next++];
      const ctl = new AbortController();
      ctls.push(ctl);
      pending++;
      fetch(u, { ...opts, signal: ctl.signal })
        .then(r => {
          if (!r.ok) throw new Error('HTTP ' + r.status);
          for (const c of ctls) if (c !== ctl) c.abort();
          settle(true, r);
        })
        .catch(e => {
          pending--;
          if (done) return;
          lastErr = e;
          if (next < urls.length) start();
          else if (!pending) settle(false, lastErr || new Error('No source answered'));
        });
      if (next < urls.length) setTimeout(start, MIRROR_STAGGER);
    };
    start();
  });
}
const REFRESH_AFTER = 24 * 3600e3;   // re-download saved playlists older than this
const FRESH_FOR = 6 * 3600e3;        // test/play results newer than this aren't re-tested
const S = {
  playlists: [],        // [{ id, name, url, count, addedAt, updatedAt }]
  channels: [],         // channels of the selected playlist: { key, name, logo, group, sources: [{ url, name, hdr }] }
  byKey: new Map(),     // channel key -> channel
  byUrl: new Map(),     // stream URL -> channel
  numByKey: new Map(),  // channel key -> channel number (position in the playlist, from 1)
  filtered: [],         // what the channel picker lists (next / previous step through it)
  health: new Map(),    // stream URL -> health record
  hosts: new Map(),     // server host -> { ok, blocked, dead } from recent tests
  favs: new Map(),      // channel key -> saved channel
  settings: { ...DEFAULT_SETTINGS },
  ui: { currentId: null, lastKey: '', volume: 1, muted: false },
  recent: [],           // recently watched channels, newest first (saved copies, so they work across playlists)
  current: null,
  loading: '',          // message shown in the list while a playlist downloads
  loadError: '',        // why the automatic channel-list download failed (shown while retrying)
  note: '',             // why the channel on now couldn't play (shown on the connection panel)
  rev: 0,               // counts every change the screen should redraw for (modern.js watches it)
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
        lang: attrs['tvg-language'] || '',   // e.g. "English;Arabic" or "eng" (many non-iptv-org playlists)
        cc: attrs['tvg-country'] || '',      // e.g. "US" or "US;CA"
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
      // YouTube pages aren't streams; no web player can play them (Free-TV lists some).
      if (/^https?:\/\/(www\.|m\.)?(youtube\.com|youtu\.be)\//i.test(url)) { cur = null; continue; }
      const ua = cur?.ua || (opts.match(/user-agent=([^&]*)/i) || [])[1] || '';
      const ref = cur?.ref || (opts.match(/referr?er=([^&]*)/i) || [])[1] || '';
      let cc = normCountry(splitList(cur?.cc)[0]);
      // Some lists (Free-TV) group by country ("Italy", "USA"); the Country filter already covers
      // that, so such a group becomes the channel's country instead.
      let group = cur?.group || '';
      const gcc = countryFromName(group);
      if (gcc) { cc = cc || gcc; group = ''; }
      out.push({
        name: cur?.name || url.split('/').pop() || 'Unnamed',
        logo: cur?.logo || '',
        group: group || 'Ungrouped',
        id: cur?.id || '',
        url,
        hdr: needsHeaders(ua, ref),
        // iptv-org marks these in the name: "Channel (720p) [Geo-blocked] [Not 24/7]"
        geo: /\[geo[- ]?blocked\]/i.test(cur?.name || ''),
        part: /\[not 24\/7\]/i.test(cur?.name || ''),
        langs: splitList(cur?.lang).map(l => l.toLowerCase()),
        cc,
      });
      cur = null;
    }
  }
  return out;
}

const splitList = v => (v || '').split(/[;,|]/).map(s => s.trim()).filter(Boolean);
// Two-letter country, matching iptv-org's codes (they use "uk" for the United Kingdom).
const normCountry = v => { const c = (v || '').trim().toLowerCase(); return /^[a-z]{2}$/.test(c) ? (c === 'gb' ? 'uk' : c) : ''; };
// iptv-org ids end in a country code: "CNN.us@HD" -> "us". Older saved channels: read it from the key.
const countryFromId = id => ((id || '').match(/\.([a-z]{2})(?:@|$)/i) || [])[1]?.toLowerCase() || '';
const countryOf = ch => ch.country || countryFromId((ch.key || '').replace(/^id:/, ''));
const regionNames = (() => { try { return new Intl.DisplayNames(['en'], { type: 'region' }); } catch { return null; } })();
function countryName(cc) {
  const iso = cc === 'uk' ? 'GB' : cc.toUpperCase();
  try { return regionNames?.of(iso) || iso; } catch { return iso; }
}
// "Italy", "USA", "Czech Republic", "日本 / Japan" -> two-letter code; '' when it isn't a country.
const COUNTRY_ALIASES = { usa: 'us', uk: 'uk', korea: 'kr', 'czech republic': 'cz', macau: 'mo', trinidad: 'tt',
  turkey: 'tr', 'hong kong': 'hk', russia: 'ru', iran: 'ir', 'ivory coast': 'ci', burma: 'mm', vatican: 'va' };
let countryNames = null;
function countryFromName(name) {
  const norm = v => v.toLowerCase().replace(/&/g, 'and').replace(/[^\p{L}]+/gu, ' ').trim();
  if (!name || name.length > 40) return '';
  if (!countryNames) {
    countryNames = new Map(Object.entries(COUNTRY_ALIASES));
    if (regionNames) {
      for (let a = 65; a <= 90; a++) for (let b = 65; b <= 90; b++) {
        const iso = String.fromCharCode(a, b);
        let n;
        try { n = regionNames.of(iso); } catch { continue; }
        if (n && n !== iso && !/unknown/i.test(n)) countryNames.set(norm(n), normCountry(iso));
      }
    }
  }
  for (const part of name.split('/')) {
    const cc = countryNames.get(norm(part));
    if (cc) return cc;
  }
  return '';
}
const countryFlag = cc => (cc ? [...(cc === 'uk' ? 'gb' : cc).toUpperCase()].map(c => String.fromCodePoint(0x1f1a5 + c.charCodeAt(0))).join('') : '');

/* Languages: from the playlist's own tvg-language, else iptv-org's feed data matched by channel id. */
const LANG_API = IPTV_ORG.replace('/iptv/', '/api/');
const LANG_MAX_AGE = 3 * 86400e3; // refreshed every few days; languages rarely change
const L = { map: new Map(), names: new Map(), byName: new Map(), at: 0, version: 0, loading: false };
const langDisplay = (() => { try { return new Intl.DisplayNames(['en'], { type: 'language' }); } catch { return null; } })();
// "eng", "en" and "English" all become "eng" once iptv-org's language list is known.
function normLang(t) {
  t = t.toLowerCase().trim();
  if (L.names.has(t)) return t;
  if (L.byName.has(t)) return L.byName.get(t);
  if (t.length === 2 && langDisplay) {
    try { const n = langDisplay.of(t).toLowerCase(); if (L.byName.has(n)) return L.byName.get(n); } catch { /* not a language code */ }
  }
  return t;
}
function langName(code) {
  if (L.names.has(code)) return L.names.get(code);
  if (code.length <= 3 && langDisplay) { try { const n = langDisplay.of(code); if (n && n !== code) return n; } catch { /* unknown code */ } }
  return code.replace(/^./, c => c.toUpperCase());
}
const langMemo = new WeakMap();
function langsOf(ch) {
  const m = langMemo.get(ch);
  if (m && m.v === L.version) return m.l;
  let l = [];
  for (const s of ch.sources || []) for (const x of s.langs || []) l.push(normLang(x));
  if (!l.length && ch.key?.startsWith('id:')) l = L.map.get(ch.key.slice(3)) || [];
  l = [...new Set(l)];
  langMemo.set(ch, { v: L.version, l });
  return l;
}
// Short label for a guide row, e.g. "ARA·ENG" (full names in the now-playing panel).
const langTag = ch => { const l = langsOf(ch); return l.length ? l.slice(0, 2).join('·').toUpperCase() + (l.length > 2 ? '+' : '') : ''; };
function applyLangData(d) {
  if (!d || d.at === L.at) return;
  L.at = d.at;
  L.map = new Map(d.map.map(([k, v]) => [k, v.split(',')]));
  L.names = new Map(d.names);
  L.byName = new Map(d.names.map(([c, n]) => [n.toLowerCase(), c]));
  L.version++;
  channelsChanged();
  renderNow();
}
// Loads iptv-org's languages for every channel feed, keeps a compact copy in this browser.
async function loadLanguages() {
  if (L.loading) return;
  const cached = await DB.get('kv', 'langdata');
  applyLangData(cached);
  if (!S.channels.some(c => c.key.startsWith('id:'))) return; // only playlists with iptv-org ids need it
  if (cached && Date.now() - cached.at < LANG_MAX_AGE) return;
  L.loading = true;
  try {
    const [feeds, langs] = await Promise.all([
      fetchAny(LANG_API + 'feeds.json').then(r => r.json()),
      fetchAny(LANG_API + 'languages.json').then(r => r.json()),
    ]);
    const main = new Map();
    const out = [];
    for (const f of feeds) {
      if (!f.channel || !f.languages?.length) continue;
      const id = f.channel.toLowerCase();
      const v = f.languages.join(',');
      out.push([id + '@' + (f.id || '').toLowerCase(), v]); // regional feeds, e.g. abc.us@kaal
      if (f.is_main || !main.has(id)) main.set(id, v);      // the channel itself = its main feed
    }
    for (const [id, v] of main) out.push([id, v]);
    const data = { at: Date.now(), map: out, names: langs.map(l => [l.code, l.name]) };
    await DB.put('kv', data, 'langdata');
    applyLangData(data);
  } catch {
    /* offline: try again next time */
  } finally {
    L.loading = false;
  }
}
const flagHtml = ch => { const cc = countryOf(ch); return cc ? `<span class="flag" title="${esc(countryName(cc))}">${countryFlag(cc)}</span>` : ''; };

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
      ch = { key, name: cleanName(e.name) || e.name, logo: e.logo, group: e.group, country: e.cc || countryFromId(e.id), sources: [] };
      map.set(key, ch);
    } else {
      if (!ch.logo) ch.logo = e.logo;
      const cn = cleanName(e.name);
      if (cn && cn.length < ch.name.length) ch.name = cn;
      const groups = new Set(groupsOf(ch));
      for (const g of e.group.split(';')) if (g.trim()) groups.add(g.trim());
      if (groups.size > 1) groups.delete('Ungrouped'); // a list that has no group for it shouldn't add one
      ch.group = [...groups].join(';');
    }
    if (!ch.country) ch.country = e.cc || countryFromId(e.id);
    if (!ch.sources.some(s => s.url === e.url)) {
      const src = { url: e.url, name: e.name, hdr: e.hdr, geo: e.geo, part: e.part };
      if (e.langs.length) src.langs = e.langs; // only kept when the playlist says so
      ch.sources.push(src);
    }
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
    .map((s, i) => ({ s, r: RANK[sourceStatus(s).cls] + (isMixed(s.url) ? 0.5 : 0) + (s.geo ? 0.3 : 0) + (s.part ? 0.2 : 0), i }))
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
const T = { queue: [], queued: new Set(), force: new Set(), shown: new Set(), hostActive: new Map(), activeUrls: new Set(), active: 0, done: 0, total: 0, manual: false };
function queueTests(urls, { manual = false, force = false, front = false, show = false } = {}) {
  if (manual) { T.queue = []; T.queued.clear(); T.done = 0; T.total = T.active; T.manual = true; }
  const add = [];
  for (const u of urls) {
    if (T.queued.has(u)) continue;
    T.queued.add(u);
    if (force) T.force.add(u);
    if (show) T.shown.add(u);
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
  T.shown.delete(url);
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
    T.activeUrls.add(url);
    T.hostActive.set(host, (T.hostActive.get(host) || 0) + 1);
    scheduleRender(); // show "Checking" on that row
    probe(url)
      .catch(e => ({ at: Date.now(), status: 'dead', note: String(e.message || e) }))
      .then(p => recordProbe(url, p))
      .finally(() => {
        T.active--;
        T.activeUrls.delete(url);
        T.hostActive.set(host, T.hostActive.get(host) - 1);
        finishTest(url);
        pump();
      });
  }
}
// The picker shows test progress (modern.js); this just tells it something changed.
const updateTestUi = () => scheduleRender();
// What a row should say while the tester is busy with it.
function testState(ch) {
  const vis = s => T.manual || T.shown.has(s.url);
  if (ch.sources.some(s => vis(s) && T.activeUrls.has(s.url))) return 'checking';
  if (ch.sources.some(s => vis(s) && T.queued.has(s.url))) return 'queued';
  return '';
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

/* =========================================================================
   Redraws: the screen (modern.js) redraws what changed whenever S.rev moves.
   ========================================================================= */
function scheduleRender() { S.rev++; }
// The channels or their order changed (a playlist loaded or refreshed, history cleared).
function channelsChanged() { S.rev++; window.Modern?.sync(); }
const chNum = ch => S.numByKey.get(ch.key) ?? '★';
// A channel can sit in several groups, written "News;Sports" (iptv-org does this).
const groupsOf = ch => ch.group.split(';').map(g => g.trim()).filter(Boolean);
const groupLabel = ch => groupsOf(ch).join(', ');

/* =========================================================================
   Playback: hls.js for HLS, mpegts.js for raw TS/FLV, the browser for the rest.
   A channel's sources are tried best-first; if one fails or hangs, the next one
   takes over automatically. Every attempt is measured and remembered.
   ========================================================================= */
const video = $('#video');
let hls = null, mpeg = null, engine = '', nativeFail = null, nativeHls = false;
// Safari's AirPlay support; only Apple's browsers have this.
const AIRPLAY = 'WebKitPlaybackTargetAvailabilityEvent' in window;
let playToken = 0, session = null, startTimer = null;

/* The TV screen around the video: test pattern when idle, static while tuning,
   the green channel number in the corner. Purely visual. */
const TV = (() => {
  const canvas = $('#snow'), card = $('#testcard'), osd = $('#osd');
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const ctx = canvas.getContext('2d');
  canvas.width = 160;
  canvas.height = 90;
  const img = ctx.createImageData(160, 90);
  let raf = 0, last = 0, osdTimer;
  function frame(t) {
    if (t - last > 50) { // ~20 fps is plenty for static
      last = t;
      const d = img.data;
      for (let p = 0; p < d.length; p += 4) { const v = Math.random() * 255 | 0; d[p] = d[p + 1] = d[p + 2] = v; d[p + 3] = 255; }
      ctx.putImageData(img, 0, 0);
    }
    raf = reduceMotion ? 0 : requestAnimationFrame(frame);
  }
  function snow(on, dim = false) {
    cancelAnimationFrame(raf);
    raf = 0;
    const show = on && S.settings.fx;
    canvas.classList.toggle('hidden', !show);
    canvas.classList.toggle('dim', dim);
    if (show) { last = 0; frame(performance.now()); }
  }
  function osdShow(html, ms = 3000) {
    osd.innerHTML = html;
    osd.classList.add('on');
    clearTimeout(osdTimer);
    osdTimer = setTimeout(() => osd.classList.remove('on'), ms);
  }
  const osdChannel = ch => osdShow(`CH ${chNum(ch)}<small>${esc(ch.name)}</small>`);
  const api = {
    state: 'standby', // standby | tuning | live | buffering | nosignal | sleep — shown on the connection panel
    setState(s) { api.state = s; window.Modern?.live(); },
    idle() { snow(false); card.classList.remove('hidden'); api.setState('standby'); },
    tune(ch) {
      card.classList.add('hidden');
      snow(true);
      osdChannel(ch);
      api.setState('tuning');
    },
    picture(ch) { snow(false); card.classList.add('hidden'); if (ch) osdChannel(ch); api.setState('live'); },
    noSignal() { card.classList.add('hidden'); snow(true, true); api.setState('nosignal'); },
    osdShow,
    refreshFx() { document.body.classList.toggle('fx', S.settings.fx); if (!S.settings.fx) snow(false); },
  };
  return api;
})();

/* Sleep timer: the sleep selector sets it (set), the S key adds 30 minutes up to 3 hours, then off (cycle).
   At the end the sound fades out over 10 seconds and the channel stops. */
const Sleep = (() => {
  const STEPS = [0, 30, 60, 90, 120, 150, 180]; // minutes
  const FADE_MS = 10000;
  let step = 0, endsAt = 0, timer = 0, fadeFrom = null;
  const two = n => String(n).padStart(2, '0');
  function fmt(ms) {
    const s = Math.max(0, Math.ceil(ms / 1000)), h = Math.floor(s / 3600);
    return h ? `${h}:${two(Math.floor(s / 60) % 60)}:${two(s % 60)}` : `${Math.floor(s / 60)}:${two(s % 60)}`;
  }
  const words = min => (min < 60 ? `${min} min` : `${Math.floor(min / 60)} h${min % 60 ? ` ${min % 60} min` : ''}`);
  function restoreVolume() {
    if (fadeFrom !== null) { video.volume = fadeFrom; fadeFrom = null; }
  }
  function stop() {
    clearInterval(timer);
    restoreVolume();
    step = 0; endsAt = 0;
  }
  function finish() {
    const vol = fadeFrom;
    clearInterval(timer);
    step = 0; endsAt = 0;
    if (session?.started) {
      video.pause();
      if (hls) hls.stopLoad(); // stop downloading while asleep
      if (mpeg) { try { mpeg.unload(); } catch { /* already stopped */ } }
    }
    if (vol !== null) video.volume = vol; // back to your normal level for next time
    fadeFrom = null;
    TV.setState('sleep');
    if (S.current) showOverlay('<b>☾ SLEEP TIMER</b><div class="muted">Time’s up, so the sound is off.</div>', [['resume', 'Resume watching']]);
  }
  function tick() {
    const left = endsAt - Date.now();
    if (left <= 0) return finish();
    if (left <= FADE_MS && session?.started && !video.paused) {
      if (fadeFrom === null) fadeFrom = video.volume;
      video.volume = Math.max(0, fadeFrom * (left / FADE_MS));
    }
  }
  function cycle() {
    step = (step + 1) % STEPS.length;
    const min = STEPS[step];
    if (!min) { stop(); toast('Sleep timer off'); TV.osdShow('☾ SLEEP<small>OFF</small>', 1500); return; }
    restoreVolume();
    endsAt = Date.now() + min * 60000;
    clearInterval(timer);
    timer = setInterval(tick, 250);
    toast(`Sleep timer: sound off in ${words(min)}`);
    TV.osdShow(`☾ SLEEP<small>${fmt(min * 60000)}</small>`, 2000);
  }
  // The sleep selector: a number of minutes, or 0 for off.
  function set(min) {
    if (!min) { if (endsAt) { stop(); toast('Sleep timer off'); } return; }
    restoreVolume();
    step = Math.max(0, STEPS.findIndex(m => m >= min));
    endsAt = Date.now() + min * 60000;
    clearInterval(timer);
    timer = setInterval(tick, 250);
    toast(`Sleep timer: sound off in ${words(min)}`);
    TV.osdShow(`☾ SLEEP<small>${fmt(min * 60000)}</small>`, 2000);
  }
  return {
    cycle,
    set,
    at: () => endsAt,
    stop,
    active: () => endsAt > 0,
    left: () => fmt(endsAt - Date.now()),
    fading: () => fadeFrom !== null,
    // Changing channel during the final fade means you're awake: cancel the timer.
    wake() { if (fadeFrom !== null) { stop(); toast('Sleep timer cancelled'); } },
  };
})();

function teardown() {
  if (hls) { hls.destroy(); hls = null; }
  if (mpeg) {
    try { mpeg.pause(); mpeg.unload(); mpeg.detachMediaElement(); mpeg.destroy(); } catch { /* already gone */ }
    mpeg = null;
  }
  nativeFail = null;
  nativeHls = false;
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
  Sleep.wake();
  leaveSession();
  teardown();
  S.current = ch;
  S.ui.lastKey = ch.key;
  saveUi();
  let order = orderedSources(ch);
  if (startUrl) order = [order.find(s => s.url === startUrl), ...order.filter(s => s.url !== startUrl)].filter(Boolean);
  session = { ch, order, idx: -1 };
  scheduleRender();
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
  S.note = s.idx ? `Trying backup source ${s.idx + 1} of ${s.order.length}…` : '';
  renderNow();
  TV.tune(s.ch);
  showOverlay('<div class="spinner"></div>' + (s.idx ? `Trying backup source ${s.idx + 1} of ${s.order.length}…` : 'Tuning…'));
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
    if (kind === 'hls' && !(AIRPLAY && video.canPlayType('application/vnd.apple.mpegurl'))) await loadLib('hls').catch(() => {});
    else if (kind === 'mpegts' || kind === 'flv') await loadLib('mpegts').catch(() => {});
    if (token !== playToken) return;
    startEngine(kind, url, token);
  })();
  return true;
}

function startEngine(kind, url, token) {
  const fail = msg => { if (token === playToken) onPlayFail(msg); };
  if (kind === 'hls') {
    // Safari (iPhone, iPad, Mac) plays HLS itself, and only a stream the browser
    // plays itself can be handed to an Apple TV with AirPlay; hls.js builds the
    // video inside the page, so AirPlay can't send it. So on AirPlay-capable
    // browsers use the built-in player; everywhere else keep hls.js.
    if (AIRPLAY && video.canPlayType('application/vnd.apple.mpegurl')) {
      nativeHls = true;
    } else if (window.Hls && Hls.isSupported()) {
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
  S.note = `Still loading after ${S.settings.timeoutSec}s: slow or offline right now`;
  showOverlay(`<b>⏳ Still loading after ${S.settings.timeoutSec}s</b><div class="muted">This channel is slow or offline right now.</div>`,
    [['wait', 'Keep waiting'], ['next', 'Next channel'], ['broken', 'Mark broken & skip']]);
}

function onPlayFail(msg) {
  const s = session;
  if (!s || s.failed) return;
  s.failed = true;
  S.note = msg;
  clearTimeout(startTimer);
  recordFail(s, msg, !s.started);
  teardown();
  TV.noSignal();
  if (!s.started && nextSource()) return; // a backup source takes over
  if (S.settings.autoSkip && !s.started) {
    showOverlay(`✖ ${esc(msg)}<div class="muted">Skipping to the next working channel…</div>`);
    setTimeout(() => { if (s.token === playToken) step(1, true); }, 1500);
    return;
  }
  const tried = s.order.length > 1 ? ` (tried all ${s.order.length} sources)` : '';
  showOverlay(`<b>NO SIGNAL</b><div>Couldn’t play this channel${tried}</div><div class="muted">${esc(msg)}</div>`,
    [['next', 'Next channel'], ['retry', 'Retry'], ['copy', 'Copy link for VLC']]);
}

// Stop: the Play/Pause button while a channel is still tuning or buffering.
function stopChannel() {
  leaveSession();
  teardown();
  hideOverlay();
  TV.idle();
  scheduleRender();
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
  if (s.started) { TV.setState('live'); return; } // recovered from buffering
  TV.picture(s.ch);
  s.started = true;
  s.liveAt = Date.now();
  addRecent(s.ch);
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
  TV.setState('buffering');
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
  for (const b of document.querySelectorAll('.rate button')) b.disabled = !ch;
  if (!ch) return;
  const url = currentSourceUrl();
  const src = ch.sources.find(s => s.url === url) || ch.sources[0];
  const h = S.health.get(src.url);
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
/* =========================================================================
   Share links: your favorites, or a playlist, carried inside a link (after the #), no account needed.
   The link holds the channels themselves (compressed) or, for playlists from a URL, just the URL.
   Opening the link offers to add them to this browser.
   ========================================================================= */
const Share = (() => {
  const MAX_CHARS = 60000; // longer links break in chats and browsers
  const b64 = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const unb64 = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
  async function pack(obj) {
    const json = JSON.stringify(obj);
    if (typeof CompressionStream === 'function') {
      const stream = new Blob([json]).stream().pipeThrough(new CompressionStream('deflate-raw'));
      return 'z' + b64(new Uint8Array(await new Response(stream).arrayBuffer()));
    }
    return 'j' + b64(new TextEncoder().encode(json));
  }
  const MAX_UNPACKED = 4 * 1024 * 1024; // a link can't unpack to more than this (guards against a crafted, hugely compressed link)
  async function unpack(s) {
    if (s.length > MAX_CHARS + 1000) throw new Error('too long');
    const bytes = unb64(s.slice(1));
    if (s[0] === 'z') {
      const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      const reader = stream.getReader();
      const chunks = [];
      let size = 0;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > MAX_UNPACKED) { reader.cancel(); throw new Error('too big'); }
        chunks.push(value);
      }
      return JSON.parse(new TextDecoder().decode(await new Blob(chunks).arrayBuffer()));
    }
    return JSON.parse(new TextDecoder().decode(bytes));
  }
  const attr = (k, v) => (v ? ` ${k}="${String(v).replace(/"/g, '')}"` : '');
  // The channels as an M3U, the format this site and every player read. Channel ids are kept so iptv-org channels stay recognisable.
  function toM3u(channels) {
    const lines = ['#EXTM3U'];
    for (const ch of channels) for (const s of ch.sources || []) {
      const id = (ch.key || '').startsWith('id:') ? ch.key.slice(3) : '';
      lines.push(`#EXTINF:-1${attr('tvg-id', id)}${attr('tvg-logo', ch.logo)}${attr('group-title', ch.group)}${attr('tvg-country', (countryOf(ch) || '').toUpperCase())},${ch.name}`);
      lines.push(s.url);
    }
    return lines.join('\n');
  }
  const link = payload => `${location.origin}${location.pathname}#share=${payload}`;
  async function offer(url, what) {
    if (navigator.share && /Mobi|Android/i.test(navigator.userAgent)) {
      try { await navigator.share({ title: what, url }); return; } catch (e) { if (e.name === 'AbortError') return; }
    }
    try { await navigator.clipboard.writeText(url); toast(`Link copied: ${what}`); }
    catch { prompt('Copy this link:', url); }
  }
  async function sharePresets() {
    const list = Presets.all().filter(Boolean);
    if (!list.length) return toast('No presets to share yet');
    const payload = await pack({ t: 'presets', m3u: toM3u(list) });
    if (payload.length > MAX_CHARS) return toast('These presets are too big for one link. Use Export backup instead.');
    offer(link(payload), `${list.length} preset channel${list.length > 1 ? 's' : ''}`);
  }
  async function shareList() {
    const p = S.playlists.find(x => x.id === S.ui.currentId);
    if (!p) return toast('Pick a playlist first');
    const obj = p.url ? { t: 'list', name: p.name, url: p.url } : { t: 'list', name: p.name, m3u: (await DB.get('kv', 'pl:' + p.id)) || toM3u(S.channels) };
    const payload = await pack(obj);
    if (payload.length > MAX_CHARS) return toast('This playlist is too big for one link. Share its source URL or a backup instead.');
    offer(link(payload), p.name);
  }
  // Opening a shared link: offer to add what it carries.
  async function receive() {
    const m = location.hash.match(/^#share=([A-Za-z0-9_\-]+)/);
    if (!m) return;
    history.replaceState(null, '', location.pathname + location.search);
    let obj;
    try { obj = await unpack(m[1]); } catch { return toast('This share link is damaged'); }
    // Shared presets (and favorites links from before presets): into your empty preset slots;
    // whatever doesn't fit is added as a playlist, so nothing is lost.
    if ((obj.t === 'presets' || obj.t === 'fav') && obj.m3u) {
      const chs = buildChannels(obj.m3u);
      if (!chs.length) return toast('The link had no channels');
      if (!confirm(`Add ${chs.length} shared channel${chs.length > 1 ? 's' : ''} to your presets?`)) return;
      const before = Presets.all().filter(Boolean).length;
      Presets.fill(chs);
      const added = Presets.all().filter(Boolean).length - before;
      const saved = new Set(Presets.all().filter(Boolean).map(p => p.key));
      const rest = chs.filter(ch => !saved.has(ch.key));
      toast(added ? `Added ${added} preset${added > 1 ? 's' : ''}` : rest.length ? 'Your presets are full' : 'You already had all of them');
      if (rest.length) loadWithSpinner({ name: 'Shared channels', text: toM3u(rest) });
    } else if (obj.t === 'list') {
      if (!confirm(`Add the shared playlist “${obj.name || 'Shared playlist'}”?`)) return;
      loadWithSpinner({ name: obj.name || 'Shared playlist', url: obj.url, text: obj.m3u });
    }
  }
  return { sharePresets, shareList, receive };
})();

// Presets: 18 saved channels on the main screen (saved copies, so they work from any playlist).
const PRESET_SLOTS = 18;
const Presets = (() => {
  let list = Array(PRESET_SLOTS).fill(null);
  const norm = p => Array.from({ length: PRESET_SLOTS }, (_, i) => (p?.[i]?.key && p[i].sources ? p[i] : null));
  return {
    all: () => list,
    load(p) { list = norm(p); },
    set(p) { list = norm(p); DB.put('kv', list, 'presets'); scheduleRender(); },
    // Presets are saved copies: when a playlist loads, give them that channel's latest stream links.
    sync(byKey) {
      let changed = false;
      const next = list.map(p => {
        const ch = p && byKey.get(p.key);
        if (!ch || JSON.stringify(ch.sources) === JSON.stringify(p.sources)) return p;
        changed = true;
        return { ...p, name: ch.name, logo: ch.logo || p.logo, sources: ch.sources };
      });
      if (changed) this.set(next);
    },
    // Put channels into the empty slots, in order, skipping ones already saved.
    fill(chs) {
      const next = list.slice();
      for (const ch of chs) {
        if (next.some(p => p?.key === ch.key)) continue;
        const i = next.indexOf(null);
        if (i < 0) break;
        next[i] = { key: ch.key, name: ch.name, logo: ch.logo, group: ch.group, country: ch.country || '', sources: ch.sources };
      }
      this.set(next);
    },
  };
})();
const favRecord = ch => ({ key: ch.key, name: ch.name, logo: ch.logo, group: ch.group, country: countryOf(ch), sources: ch.sources, addedAt: Date.now() });

/* =========================================================================
   Playlists
   ========================================================================= */
async function fetchOne(url) {
  try {
    const r = await fetchAny(effectiveUrl(url), { cache: 'no-store' });
    return await r.text();
  } catch (e) {
    throw new Error(`Couldn’t download the playlist (${e.message}). The server may block browsers: download the .m3u file and upload it instead.`);
  }
}
// Several lists (separated by spaces) are downloaded together and joined, in order. If some fail,
// the rest are used, unless `all` is set (background refresh: better the saved copy than half a list).
async function fetchPlaylist(url, { all = false } = {}) {
  const urls = splitUrls(url);
  if (urls.length < 2) return fetchOne(urls[0] || url);
  const res = await Promise.allSettled(urls.map(fetchOne));
  const ok = res.filter(r => r.status === 'fulfilled').map(r => r.value);
  if (!ok.length || (all && ok.length < urls.length)) throw res.find(r => r.status === 'rejected').reason;
  if (ok.length < urls.length) toast(`${urls.length - ok.length} of ${urls.length} lists didn’t download; using the rest`);
  return ok.join('\n');
}
function nameFromUrl(url) {
  url = splitUrls(url)[0] || '';
  try { return decodeURIComponent(new URL(url).pathname.split('/').pop() || new URL(url).hostname).replace(/\.m3u8?$/i, ''); }
  catch { return ''; }
}
function renderPlaylists() {
  const cur = S.playlists.find(p => p.id === S.ui.currentId);
  $('#refreshPlaylistBtn').disabled = !cur?.url;
  $('#curListName').textContent = cur ? `Open: ${cur.name} (${cur.count} channels)` : 'No playlist open';
  $('#deletePlaylistBtn').disabled = !cur;
}
// Install a channel list and its lookup maps.
function setChannels(chs) {
  S.channels = chs;
  S.byKey = new Map(chs.map(c => [c.key, c]));
  S.numByKey = new Map(chs.map((c, i) => [c.key, i + 1]));
  S.byUrl = new Map();
  for (const c of chs) for (const s of c.sources) S.byUrl.set(s.url, c);
  Presets.sync(S.byKey);
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
  await selectPlaylist(id, chs);
  toast(`Added ${chs.length} channels`);
}
async function selectPlaylist(id, parsed) {
  S.ui.currentId = id;
  saveUi();
  setChannels(!id ? [] : parsed || buildChannels((await DB.get('kv', 'pl:' + id)) || ''));
  const meta = S.playlists.find(p => p.id === id);
  if (meta && meta.count !== S.channels.length) { // e.g. counted before duplicates were merged
    meta.count = S.channels.length;
    DB.put('kv', S.playlists, 'playlists');
  }
  renderPlaylists();
  channelsChanged();
  backgroundRefresh(S.playlists.find(p => p.id === id));
  loadLanguages();
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
    const text = await fetchPlaylist(p.url, { all: true });
    const chs = buildChannels(text);
    if (!chs.length) return;
    await savePlaylistText(p, text, chs);
    if (S.ui.currentId === p.id) {
      setChannels(chs);
      if (S.current) S.current = S.byKey.get(S.current.key) || S.current;
      renderPlaylists();
      channelsChanged();
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
  if (!p || !confirm(`Remove playlist “${p.name}”? Your presets and ratings are kept.`)) return;
  await DB.del('kv', 'pl:' + p.id);
  if (isDefaultList(p.url)) { S.ui.removedDefault = true; saveUi(); }
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
    settings: S.settings, presets: Presets.all(), health: [...S.health.values()], recent: S.recent, playlists: [],
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
    // Backups from before favorites were removed: their favorites go into empty preset slots.
    const favPresets = (data.favs || []).map(upgradeFav).filter(f => f.sources);
    for (const h of data.health || []) { S.health.set(h.url, h); await DB.put('health', h); }
    if (Array.isArray(data.presets)) Presets.fill(data.presets.filter(p => p?.key && p.sources)); // into empty slots
    if (favPresets.length) Presets.fill(favPresets);
    if (data.recent?.length) {
      const seen = new Set(S.recent.map(r => r.key));
      S.recent = [...S.recent, ...data.recent.filter(r => !seen.has(r.key))].slice(0, RECENT_MAX);
      await DB.put('kv', S.recent, 'recent');
    }
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
  if (!confirm('Clear all test results and play history? Your ratings and presets are kept.')) return;
  await DB.clear('health');
  const keep = [...S.health.values()].filter(h => h.rating);
  S.health.clear();
  S.hosts.clear();
  for (const old of keep) { const h = H(old.url); h.rating = old.rating; await DB.put('health', h); }
  channelsChanged();
  renderNow();
  toast('Test history cleared');
}
async function eraseAll() {
  if (!confirm('Erase all playlists, presets, ratings and settings from this browser?')) return;
  await Promise.all(['kv', 'health', 'favs'].map(s => DB.clear(s)));
  location.reload();
}

/* =========================================================================
   Wiring
   ========================================================================= */
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
  $('#sFx').checked = s.fx;
  $('#setDlg').showModal();
}
const clamp = (v, lo, hi, d) => { v = Math.round(+v); return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d; };

function wire() {
  $('#testOneBtn').addEventListener('click', () => {
    if (!S.current) return;
    queueTests(S.current.sources.map(s => s.url), { force: true, front: true, show: true });
    toast(S.current.sources.length > 1 ? `Testing all ${S.current.sources.length} sources…` : 'Testing…');
  });

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
    $('#plName').value = opt.dataset.name || 'iptv-org: ' + opt.textContent.trim();
  });

  $('#setForm').addEventListener('submit', e => {
    if (e.submitter?.value !== 'save') return;
    const d = DEFAULT_SETTINGS;
    S.settings = {
      slowStartSec: clamp($('#sSlow').value, 1, 60, d.slowStartSec),
      timeoutSec: clamp($('#sTimeout').value, 3, 120, d.timeoutSec),
      autoSkip: $('#sAutoSkip').checked,
      autoTest: $('#sAutoTest').checked,
      concurrency: clamp($('#sConc').value, 1, 16, d.concurrency),
      fx: $('#sFx').checked,
    };
    DB.put('kv', S.settings, 'settings');
    TV.refreshFx();
    toast('Settings saved');
  });
  $('#exportBtn').addEventListener('click', exportData);
  $('#sharePresetsBtn').addEventListener('click', Share.sharePresets);
  $('#shareListBtn').addEventListener('click', Share.shareList);
  $('#importFile').addEventListener('change', e => { if (e.target.files[0]) importData(e.target.files[0]); e.target.value = ''; });
  $('#clearStatsBtn').addEventListener('click', clearStats);
  $('#clearAllBtn').addEventListener('click', eraseAll);

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
    else if (a === 'resume' && S.current) playChannel(S.current); // back to the live picture
  });

  // Keyboard / TV remote:
  //   ↑ ↓ ← →  previous / next channel     0-9  type a channel number
  //   Space  pause                          S    sleep timer (Esc is modern.js's: closes the menu or picker)
  document.addEventListener('keydown', e => {
    if (e.target.closest?.('input, textarea, select, dialog') || e.ctrlKey || e.metaKey || e.altKey) return;
    const onButton = !!e.target.closest?.('button, a, video');
    const k = e.key;
    if (/^[0-9]$/.test(k)) return typeChannelDigit(k);
    const handled = () => e.preventDefault();
    if (['ArrowDown', 'ArrowRight', 'n', 'ChannelUp', 'MediaTrackNext'].includes(k)) { handled(); step(1); }
    else if (['ArrowUp', 'ArrowLeft', 'p', 'ChannelDown', 'MediaTrackPrevious'].includes(k)) { handled(); step(-1); }
    else if (k === ' ' && !onButton && session?.started) { handled(); video.paused ? video.play().catch(() => {}) : video.pause(); }
    else if (k === 's' || k === 'S') Sleep.cycle();
  });

  // Remember volume and mute between channels and visits.
  let volTimer;
  video.addEventListener('volumechange', () => {
    clearTimeout(volTimer);
    if (Sleep.fading()) return; // the sleep fade isn't your chosen volume
    volTimer = setTimeout(() => { if (!Sleep.fading()) { S.ui.volume = video.volume; S.ui.muted = video.muted; saveUi(); } }, 300);
  });
}
// Recently watched: newest first, saved copies so they work from any playlist.
const RECENT_MAX = 40;
function addRecent(ch) {
  const rec = { ...favRecord(ch), at: Date.now() };
  delete rec.addedAt;
  S.recent = [rec, ...S.recent.filter(r => r.key !== ch.key)].slice(0, RECENT_MAX);
  DB.put('kv', S.recent, 'recent');
  scheduleRender();
}
// Like a remote: type a channel number, it tunes in after a short pause.
let numBuf = '', numTimer;
function typeChannelDigit(d) {
  numBuf = (numBuf + d).slice(-5);
  TV.osdShow(`CH ${numBuf}_`, 1500);
  clearTimeout(numTimer);
  numTimer = setTimeout(() => {
    const n = +numBuf;
    numBuf = '';
    const ch = S.channels[n - 1];
    if (ch) playChannel(ch);
    else toast(`There’s no channel ${n}`);
  }, 1200);
}
function copyLink() {
  const url = currentSourceUrl();
  if (!url) return;
  navigator.clipboard.writeText(url).then(() => toast('Link copied'), () => prompt('Stream link:', url));
}

async function init() {
  wire();
  const [pls, settings, ui, health, favs, recentList] = await Promise.all([
    DB.get('kv', 'playlists'), DB.get('kv', 'settings'), DB.get('kv', 'ui'), DB.all('health'), DB.all('favs'), DB.get('kv', 'recent'),
  ]);
  S.recent = recentList || [];
  S.playlists = pls || [];
  // The automatic list used to be iptv-org alone: add Free-TV to it, downloaded on the next refresh.
  for (const p of S.playlists) {
    if (p.url === OLD_DEFAULT.url && p.name === OLD_DEFAULT.name) {
      Object.assign(p, { url: DEFAULT_PLAYLIST.url, name: DEFAULT_PLAYLIST.name, updatedAt: 1 }); // 1: long ago, so it refreshes now
      DB.put('kv', S.playlists, 'playlists');
    }
  }
  S.settings = { ...DEFAULT_SETTINGS, ...(settings || {}) };
  S.ui = { ...S.ui, ...(ui || {}) };
  const recent = Date.now() - 24 * 3600e3;
  for (const h of health || []) {
    S.health.set(h.url, h);
    if (h.probe && !h.probe.inferred && h.probe.at > recent) noteHost(h.url, h.probe);
  }
  for (const f of favs || []) S.favs.set(f.key, f);
  Presets.load(await DB.get('kv', 'presets'));
  // Favorites were replaced by presets: they move once into the empty preset slots. The saved favorites
  // are left in storage untouched (never shown) rather than deleted.
  if (!S.ui.favsToPresets) {
    S.ui.favsToPresets = true;
    saveUi();
    if (S.favs.size) Presets.fill([...S.favs.values()].sort((a, b) => (a.addedAt || 0) - (b.addedAt || 0)));
  }
  const vol = Number(S.ui.volume ?? 1);
  video.volume = Number.isFinite(vol) ? Math.min(1, Math.max(0, vol)) : 1;
  video.muted = !!S.ui.muted;
  TV.refreshFx();
  TV.idle();

  const startId = S.playlists.some(p => p.id === S.ui.currentId) ? S.ui.currentId : S.playlists[0]?.id || null;
  await selectPlaylist(startId);

  // Show (but don't autoplay) the channel you watched last.
  const last = S.byKey.get(S.ui.lastKey) || Presets.all().find(p => p?.key === S.ui.lastKey) || S.favs.get(S.ui.lastKey) || (S.ui.lastUrl && S.byUrl.get(S.ui.lastUrl));
  if (last?.sources) { S.current = last; scheduleRender(); }
  renderNow();

  // A share link (#share=…) carries favorites or a playlist: offer to add them.
  const shared = location.hash.startsWith('#share=');
  if (shared) Share.receive();
  addEventListener('hashchange', () => { if (location.hash.startsWith('#share=')) Share.receive(); });
  // Shortcut: ?m3u=<playlist url> adds that playlist (once).
  const qp = new URLSearchParams(location.search).get('m3u');
  if (shared) { /* handled above */ }
  else if (qp && !S.playlists.some(p => p.url === qp)) {
    // Ask first: a link shouldn't be able to add a playlist to someone's player without them noticing.
    history.replaceState(null, '', location.pathname);
    if (/^https?:\/\//i.test(qp) && confirm(`Add the playlist from ${new URL(qp).host}?`)) loadWithSpinner({ url: qp });
  } else {
    // No playlist: load the iptv-org list by itself, and keep retrying until it arrives.
    // Only removing that list on purpose (the 🗑 button) stops this.
    ensureDefaultPlaylist();
    window.addEventListener('online', () => ensureDefaultPlaylist(true));
  }
  // Fetch the HLS library in the background once the page is up, so the first click is quick.
  setTimeout(() => loadLib('hls').catch(() => {}), 1500);
}
async function loadWithSpinner(pl) {
  S.loading = `Loading ${pl.name || 'playlist'}…`;
  scheduleRender();
  try {
    await addPlaylist(pl);
    return true;
  } catch (e) {
    toast(e.message);
    return false;
  } finally {
    S.loading = '';
    scheduleRender();
  }
}
// Automatic channel list: downloads the iptv-org list when there is none, retrying with a
// growing pause (5 s, 15 s, 30 s, then every minute) and again as soon as the network returns.
const RETRY_PAUSES = [5e3, 15e3, 30e3, 60e3];
let retryTimer = null, retryCount = 0;
async function ensureDefaultPlaylist(now = false) {
  clearTimeout(retryTimer);
  retryTimer = null;
  if (S.playlists.length || S.ui.removedDefault || S.loading) return;
  if (now) retryCount = 0;
  S.loading = `Loading ${DEFAULT_PLAYLIST.name}…`;
  scheduleRender();
  try {
    await addPlaylist(DEFAULT_PLAYLIST);
    S.loadError = '';
    retryCount = 0;
  } catch {
    S.loadError = `None of the ${1 + IPTV_MIRRORS.length} sources answered. Check your internet connection.`;
    const pause = RETRY_PAUSES[Math.min(retryCount++, RETRY_PAUSES.length - 1)];
    retryTimer = setTimeout(ensureDefaultPlaylist, pause);
  } finally {
    S.loading = '';
    scheduleRender();
  }
}

/* Quick-pick of iptv-org lists in the Add dialog (all channels, or one country). */
let countriesLoaded = false;
async function loadIptvOrgChoices() {
  if (countriesLoaded) return;
  countriesLoaded = true;
  try {
    const list = await (await fetchAny(LANG_API + 'countries.json')).json();
    list.sort((a, b) => a.name.localeCompare(b.name));
    $('#plPreset').insertAdjacentHTML('beforeend', '<optgroup label="By country">' +
      list.map(c => `<option value="${IPTV_ORG}countries/${esc(c.code.toLowerCase())}.m3u">${esc(c.flag || '')} ${esc(c.name)}</option>`).join('') +
      '</optgroup>');
  } catch {
    countriesLoaded = false; // try again next time the dialog opens
  }
}
init();

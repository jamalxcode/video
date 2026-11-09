'use strict';
/* The screen: now playing (with the TV picture), presets, recently watched and the channel picker.
   Modelled on radio.sala.company's screen. The player, tester, playlists and storage are in app.js. */
window.Modern = (() => {
  const root = document.getElementById('modernApp');
  if (!root) return null;
  const $m = id => document.getElementById(id);
  const WIDE = '(min-width: 1050px)';
  let browserOpen = matchMedia(WIDE).matches;
  let navOpen = false;
  // What the picker shows: a playlist ('list') or recently watched, narrowed by language, country, genre and search.
  let view = 'list', lang = '', country = '', genre = '', query = '';
  let chosenPreset = -1; // the exact slot tapped, even if the same channel is saved twice
  let holdTimer = 0, held = false;
  let items = [];        // the channels the picker lists (all of them, not only the rows drawn)
  let drawnSig = '', presetSig = '', recentSig = '', liveSig = '';

  const safe = x => esc(String(x ?? ''));
  const alpha = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });
  const sortName = n => n.trim().replace(/^[^\p{L}\p{N}]+/u, '');
  const logo = (ch, cls = '') => ch?.logo
    ? `<img class="${cls}" loading="lazy" referrerpolicy="no-referrer" src="${safe(ch.logo)}" alt="" onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'m-fallback',textContent:'▶'}))">`
    : '<span class="m-fallback">▶</span>';
  const channelFor = c => S.byKey.get(c.key) || c;
  const status = ch => { try { return channelStatus(ch); } catch { return { cls: 'untested', label: '' }; } };
  // Verified: a real test or play (or your own "Smooth" rating) shows it works, not just a guess.
  const verified = ch => status(ch).cls === 'good' && ch.sources.some(s => {
    const h = S.health.get(s.url);
    return h?.rating === 'good' || h?.probe?.status === 'ok' || h?.lastResult === 'ok';
  });
  function marker(ch) {
    const st = status(ch), ts = testState(ch), good = verified(ch);
    const cls = ts ? 'checking' : good ? 'good' : st.cls === 'good' ? 'untested' : st.cls;
    const label = ts === 'checking' ? 'Checking…' : ts === 'queued' ? 'Waiting to be checked'
      : good ? 'Verified working' : ({ warn: 'Slow or buffers', bad: 'Unavailable', blocked: 'Blocked in browsers', untested: 'Not checked yet' }[cls] || 'Not checked yet');
    const text = ts ? '◌' : good ? '✓' : ({ warn: '! Slow', bad: '×', blocked: '×', untested: '?' }[cls] || '?');
    return `<span class="m-status m-status-${cls}" aria-label="${label}" title="${safe(st.tip ? label + ' · ' + st.tip : label)}">${text}</span>`;
  }

  /* ---------- overlays: the picker and the menu cover the screen on narrow widths ---------- */
  const overlayMode = () => !matchMedia(WIDE).matches;
  function syncInert() {
    const narrow = overlayMode();
    root.querySelector('.m-central').inert = narrow && (browserOpen || navOpen);
    $m('mBrowser').inert = (narrow && navOpen) || !browserOpen;
    $m('mNav').inert = narrow && !navOpen;
  }
  function openBrowser(open) {
    browserOpen = open;
    root.classList.toggle('m-browser-open', open);
    $m('mChannelToggle').setAttribute('aria-expanded', String(open));
    syncInert();
    if (open) {
      drawnSig = '';
      draw();
      if (overlayMode()) $m('mBrowserClose').focus({ preventScroll: true });
    } else if (overlayMode()) $m('mChannelToggle').focus({ preventScroll: true });
  }
  function openNav(open) {
    navOpen = open;
    root.classList.toggle('m-nav-open', open);
    syncInert();
    if (open) root.querySelector('.m-navitem')?.focus({ preventScroll: true });
  }
  function setView(v) {
    view = v; lang = ''; country = ''; genre = ''; query = ''; $m('mSearch').value = '';
    openNav(false);
    openBrowser(true);
    scrollColumns(v === 'list' ? 0 : 4);
  }

  /* ---------- the channel list behind the picker ---------- */
  // Sorted A–Z once per channel set, so filtering keeps that order without re-sorting 12,000 names.
  let sortedFor = null, sorted = [];
  function source() {
    if (view === 'recent') return S.recent.map(channelFor);
    return S.channels;
  }
  function sortedSource() {
    const src = source();
    const sig = view === 'list' ? src : view + '|' + src.map(c => c.key).join('|');
    if (sig !== sortedFor) {
      sortedFor = sig;
      sorted = view === 'recent' ? src.slice() // newest first
        : src.slice().sort((a, b) => alpha.compare(sortName(a.name), sortName(b.name)) || alpha.compare(a.name, b.name));
    }
    return sorted;
  }
  // A channel can have several languages; one with none listed goes under "Unknown".
  const langsFor = ch => { const l = langsOf(ch); return l.length ? l : ['__none__']; };
  const inLang = ch => !lang || langsFor(ch).some(l => lang.split('|').includes(l));
  const ccOf = ch => countryOf(ch) || '__other__';
  const genresOf = ch => { const g = groupsOf(ch); return g.length ? g : ['Other']; };
  const inCountry = ch => !country || country.split('|').includes(ccOf(ch));
  const inGenre = ch => !genre || genresOf(ch).some(g => genre.split('|').includes(g));
  function matches(ch) {
    if (!query) return true;
    const hay = [ch.name, ch.group, countryOf(ch) ? countryName(countryOf(ch)) : '', langsOf(ch).map(langName).join(' ')].join(' ').toLowerCase();
    return query.split(/\s+/).every(w => hay.includes(w));
  }
  // Works out what's listed and hands it to the player, so next / previous follow the picker.
  function compute() {
    items = sortedSource().filter(ch => inLang(ch) && inCountry(ch) && inGenre(ch) && matches(ch));
    S.filtered = items;
  }

  /* ---------- the picker: Collections → Languages → Countries → Genres → Channels ---------- */
  let shownListId;
  function draw() {
    // Another playlist opened (added, removed, imported, shared): show its channels, not the old filters.
    if (S.ui.currentId !== shownListId) {
      if (shownListId !== undefined && view === 'list') { lang = ''; country = ''; genre = ''; query = ''; $m('mSearch').value = ''; }
      shownListId = S.ui.currentId;
    }
    compute();
    if (!browserOpen) return;
    const all = sortedSource();
    const langs = new Map(), countries = new Map(), genres = new Map();
    for (const ch of all) {
      for (const l of langsFor(ch)) langs.set(l, (langs.get(l) || 0) + 1);
      if (!inLang(ch)) continue;
      const cc = ccOf(ch);
      countries.set(cc, (countries.get(cc) || 0) + 1);
      if (!inCountry(ch)) continue;
      for (const g of genresOf(ch)) genres.set(g, (genres.get(g) || 0) + 1);
    }
    const lLabel = l => (l === '__none__' ? 'Unknown' : langName(l));
    const lSorted = [...langs].sort((a, b) => (a[0] === '__none__') - (b[0] === '__none__') || alpha.compare(lLabel(a[0]), lLabel(b[0])));
    const ccLabel = cc => (cc === '__other__' ? 'Other' : countryName(cc));
    const ccSorted = [...countries].sort((a, b) => alpha.compare(ccLabel(a[0]), ccLabel(b[0])));
    const gSorted = [...genres].sort((a, b) => alpha.compare(a[0], b[0]));

    const pick = (attr, cur, value, label, n, extra = '') =>
      `<button type="button" data-${attr}="${safe(value)}" class="${cur === value ? 'selected' : ''}"${extra}>${label}${n != null ? ` <small>${n}</small>` : ''}<span>›</span></button>`;
    const merged = (attr, cur, e, single) => e.keys.length === 1 ? single(e.keys[0], e.n)
      : `<button type="button" data-${attr}="${safe(e.keys.join('|'))}" class="m-merged${cur === e.keys.join('|') ? ' selected' : ''}" title="${safe(e.labels.join(', '))}" aria-label="${safe(e.labels.join(', ') + ', ' + e.n + ' channels')}" data-names="${safe(JSON.stringify(e.labels))}"${attr === 'country' ? ` data-codes="${safe(e.keys.map(k => (k === '__other__' ? 'Other' : k.toUpperCase())).join('·'))}"` : ''}><b class="m-merge-names">${safe(e.labels.join(' · '))}</b> <small>${e.n}</small><span>›</span></button>`;

    const lists = '<div class="m-column m-column-source"><h3>Collections</h3>' +
      S.playlists.map(p => pick('list', view === 'list' ? S.ui.currentId : null, p.id, safe(p.name), p.count)).join('') +
      pick('list', view === 'recent' ? '__recent__' : null, '__recent__', '◷ Recently watched', S.recent.length) +
      '<button type="button" data-add-list class="m-add-list">＋ Add playlist</button></div>';
    // A merged row counts each channel once, even one that's in several of its languages or genres.
    const recount = (entries, pool, keysOf) => entries.map(e => (e.keys.length < 2 ? e
      : { ...e, n: pool.filter(ch => keysOf(ch).some(k => e.keys.includes(k))).length }));
    const inL = all.filter(inLang), inLC = inL.filter(inCountry);
    const lCol = `<div class="m-column"><h3>Languages <small>${langs.size}</small></h3>` + pick('lang', lang, '', 'All languages') +
      lSorted.map(([l, n]) => pick('lang', lang, l, safe(lLabel(l)), n)).join('') + '</div>'; // every language on its own row
    const ccCol = `<div class="m-column"><h3>Countries <small>${countries.size}</small></h3>` + pick('country', country, '', 'All countries') +
      recount(mergeSmall(ccSorted.map(([cc, n]) => ({ key: cc, n, label: ccLabel(cc) }))), inL, ch => [ccOf(ch)]).map(e => merged('country', country, e,
        (cc, n) => pick('country', country, cc, (cc === '__other__' ? '' : countryFlag(cc) + ' ') + safe(ccLabel(cc)), n))).join('') + '</div>';
    const gCol = `<div class="m-column"><h3>Genres <small>${genres.size}</small></h3>` + pick('genre', genre, '', 'All genres') +
      recount(mergeSmall(gSorted.map(([g, n]) => ({ key: g, n, label: g }))), inLC, genresOf).map(e => merged('genre', genre, e,
        (g, n) => pick('genre', genre, g, safe(g), n))).join('') + '</div>';
    const rows = items.slice(0, 350).map((ch, i) => {
      const on = S.current?.key === ch.key;
      return `<div class="m-st-row${verified(ch) ? ' m-verified' : ''}${on ? ' m-on' : ''}"><button type="button" data-ch="${i}" class="m-st-select" title="${safe(ch.name)}"${on ? ' aria-current="true"' : ''}>${logo(ch)}<span class="m-st-text"><strong>${flagHtml(ch)}${safe(ch.name)}</strong>${langTag(ch) ? `<small class="m-lang" title="${safe(langsOf(ch).map(langName).join(', '))}">${safe(langTag(ch))}</small>` : ''}${marker(ch)}</span></button></div>`;
    }).join('');
    const chCol = `<div class="m-column m-column-stations"><h3>Channels <small>${items.length}</small></h3>` + (rows || emptyText()) +
      (items.length > 350 ? '<p class="m-more">Showing the first 350. Pick a language, country or genre, or search, to narrow it down.</p>' : '') + '</div>';

    const holder = $m('mColumns');
    const x = holder.scrollLeft, ys = [...holder.children].map(c => c.scrollTop);
    holder.innerHTML = lists + lCol + ccCol + gCol + chCol;
    holder.scrollLeft = x;
    [...holder.children].forEach((c, i) => { c.scrollTop = ys[i] || 0; });
    fitMergedNames();
    autoTestSoon();
  }
  function emptyText() {
    if (S.loading) return `<p class="m-empty"><span class="m-spin"></span>${safe(S.loading)}</p>`;
    if (view === 'list' && !S.playlists.length) {
      return S.loadError
        ? `<p class="m-empty">Couldn’t download the channel list. ${safe(S.loadError)} Retrying automatically…</p><div class="m-empty-acts"><button type="button" data-act="seed">Retry now</button><button type="button" data-add-list>＋ Add your own</button></div>`
        : '<p class="m-empty">No playlist yet.</p><div class="m-empty-acts"><button type="button" data-act="seed">Load all channels</button><button type="button" data-add-list>＋ Add your own</button></div>';
    }
    if (view === 'recent' && !S.recent.length) return '<p class="m-empty">Nothing watched yet. Channels you play show up here.</p>';
    return '<p class="m-empty">No channels match. Try another collection, language, country or genre.</p>';
  }
  // Countries / genres with only 1–2 channels are merged, A–Z, with the next small ones until the group
  // holds at least 6, so these columns scroll less. Bigger entries stay as they are.
  function mergeSmall(entries) {
    const out = [];
    let bucket = null;
    for (const e of entries) {
      if (e.n > 2) { out.push({ keys: [e.key], labels: [e.label], n: e.n }); continue; }
      if (!bucket) { bucket = { keys: [], labels: [], n: 0 }; out.push(bucket); }
      bucket.keys.push(e.key); bucket.labels.push(e.label); bucket.n += e.n;
      if (bucket.n >= 6) bucket = null;
    }
    if (bucket && bucket.n < 6) { // a short leftover joins the previous merged group
      const prev = out.slice(0, out.indexOf(bucket)).reverse().find(g => g.keys.length > 1);
      if (prev) { prev.keys.push(...bucket.keys); prev.labels.push(...bucket.labels); prev.n += bucket.n; out.splice(out.indexOf(bucket), 1); }
    }
    return out;
  }
  // Merged names stay on one line: shorten each a step at a time; countries then switch to their codes.
  const shorten = (name, k) => (name.length <= k + 1 ? name : name.slice(0, k).replace(/[\s.,&-]+$/, '') + '.');
  function fitMergedNames() {
    for (const b of $m('mColumns').querySelectorAll('.m-merged')) {
      const el = b.querySelector('.m-merge-names'), names = JSON.parse(b.dataset.names || '[]');
      el.textContent = names.join(' · ');
      for (let k = 10; k >= 3 && el.scrollWidth > el.clientWidth; k--) el.textContent = names.map(n => shorten(n, k)).join(k <= 4 ? '·' : ' · ');
      if (b.dataset.codes && el.scrollWidth > el.clientWidth && /(^|·)\S{1,3}\.(·|$)/.test(el.textContent)) el.textContent = b.dataset.codes;
    }
  }
  function scrollColumns(i) {
    const holder = $m('mColumns'), col = holder.children[i];
    if (!col) return;
    holder.scrollTo({ left: col.offsetLeft - holder.children[0].offsetLeft, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
  }
  // Quiet checks for the channel rows on screen, while you scroll (Settings → test quietly).
  let autoTimer = 0;
  function autoTestSoon() { clearTimeout(autoTimer); autoTimer = setTimeout(autoTestShown, 500); }
  function autoTestShown() {
    if (!S.settings.autoTest || !browserOpen) return;
    const holder = $m('mColumns'), box = holder.getBoundingClientRect();
    const onScreen = [...holder.querySelectorAll('.m-column-stations [data-ch]')].filter(b => {
      const r = b.getBoundingClientRect();
      return r.bottom > box.top && r.top < box.bottom && r.right > box.left && r.left < box.right;
    }).map(b => items[+b.dataset.ch]).filter(Boolean);
    const urls = testUrlsFor(onScreen);
    if (urls.length) queueTests(urls, { show: true });
  }

  /* ---------- presets and recently watched ---------- */
  function paintPresets() {
    const list = Presets.all();
    // Only one slot lights up: the one you tapped, else the first slot holding the channel that's on.
    const hits = list.map((p, i) => (p && S.current?.key === p.key ? i : -1)).filter(i => i >= 0);
    const active = hits.includes(chosenPreset) ? chosenPreset : hits[0] ?? -1;
    const sig = list.map(p => p?.key || '').join('|') + '|' + active;
    if (sig === presetSig) return;
    presetSig = sig;
    $m('mPresets').innerHTML = list.map((p, i) =>
      `<button type="button" class="m-preset${i === active ? ' active' : ''}" data-preset="${i}" title="${safe(p ? p.name + ' · long-press to replace' : 'Long-press to save the channel that’s on')}" aria-label="Preset ${i + 1}${p ? ' ' + safe(p.name) : ' empty'}; long-press or Shift Enter to save the channel that’s on">` +
      `<span class="m-preset-number">${i + 1}</span>${p ? logo(p) : '<span class="m-preset-add">＋</span>'}<span class="m-preset-label">${safe(p?.name || 'Save')}</span></button>`).join('');
  }
  function paintRecent() {
    const rec = S.recent.slice(0, 12);
    const sig = rec.map(r => r.key).join('|');
    if (sig === recentSig) return;
    recentSig = sig;
    $m('mRecent').innerHTML = rec.length
      ? rec.map((r, i) => `<button type="button" data-recent="${i}" title="${safe(r.name)}">${logo(r)}<span>${safe(r.name)}</span></button>`).join('')
      : '<p class="m-empty">Channels you watch show up here.</p>';
  }
  function assign(i) {
    if (!S.current) return toast('Play a channel first, then long-press a preset to save it');
    const list = Presets.all().slice();
    const ch = S.current;
    list[i] = { key: ch.key, name: ch.name, logo: ch.logo, group: ch.group, country: countryOf(ch), sources: ch.sources };
    Presets.set(list);
    chosenPreset = i;
    paintPresets();
    toast(`Saved ${ch.name} to preset ${i + 1}`);
  }

  /* ---------- now playing ---------- */
  const STATES = {
    standby: ['Ready', 'Choose a channel to watch'],
    stopped: ['Ready', 'Tap Play to watch'],
    tuning: ['Connecting…', 'Opening the stream'],
    live: ['Connected · On air', ''],
    paused: ['Paused', 'Tap Play to carry on'],
    buffering: ['Buffering…', 'Waiting for the stream to catch up'],
    nosignal: ['No signal', 'Couldn’t play this channel'],
    sleep: ['Sleeping', 'The sleep timer turned the sound off. Tap Play to carry on'],
  };
  function liveState() {
    if (!S.current) return 'standby';
    const st = TV.state;
    if (st === 'live' && video.paused) return 'paused';
    if (st === 'standby') return 'stopped';
    return STATES[st] ? st : 'standby';
  }
  function paintLive() {
    const ch = S.current, state = liveState();
    const sig = [ch?.key, ch?.name, state, S.note, status(ch || { sources: [] }).cls, testState(ch || { sources: [] }), S.rev].join('|');
    if (sig !== liveSig) {
      liveSig = sig;
      $m('mNowName').innerHTML = ch ? flagHtml(ch) + safe(ch.name) : 'Pick a channel';
      $m('mNowLogo').innerHTML = ch ? logo(ch) : '▶';
      const cc = ch && countryOf(ch);
      $m('mNowMeta').textContent = ch
        ? [`CH ${chNum(ch)}`, cc ? countryName(cc) : '', groupLabel(ch), langsOf(ch).map(langName).slice(0, 2).join(', ')].filter(Boolean).join(' · ')
        : 'Tap Channels to find something to watch';
      $m('mNowBadge').innerHTML = ch ? marker(ch) : '';
      $m('mDetails').hidden = !ch;
      for (const b of [$m('mPrev'), $m('mNext')]) b.disabled = !S.filtered.length;
    }
    const [title, generic] = STATES[state];
    let detail = generic;
    if (['tuning', 'nosignal'].includes(state) && S.note) detail = S.note;
    if (state === 'live') detail = liveDetail();
    $m('mConnection').dataset.state = state;
    if ($m('mConnTitle').textContent !== title) $m('mConnTitle').textContent = title;
    if ($m('mConnSub').textContent !== detail) $m('mConnSub').textContent = detail;
    $m('mRetry').hidden = state !== 'nosignal';
    // While connecting or buffering a press stops the attempt, so it shows pause too.
    const busy = ['live', 'tuning', 'buffering'].includes(state);
    $m('mPlay').textContent = busy ? '❚❚' : '▶';
    $m('mPlay').setAttribute('aria-label', busy ? 'Pause' : 'Play');
    $m('mPlay').disabled = !ch;
    if (document.activeElement !== $m('mVolume')) $m('mVolume').value = Math.round((video.muted ? 0 : video.volume) * 100);
    paintSleep();
    paintMediaSession();
  }
  // "Source 1 of 2 · HLS · 720p"
  function liveDetail() {
    const s = session;
    if (!s) return '';
    const kind = nativeHls ? 'HLS' : { hls: 'HLS', mpegts: 'TS', native: 'Direct' }[engine] || '';
    return [s.order.length > 1 ? `Source ${s.idx + 1} of ${s.order.length}` : '', kind, video.videoHeight ? video.videoHeight + 'p' : ''].filter(Boolean).join(' · ') || 'Picture confirmed';
  }
  // One sleep control: the chosen duration shows the live countdown; Sleep Off cancels.
  const sleepSel = $m('mSleep');
  for (const o of sleepSel.options) o.dataset.label = o.textContent;
  function paintSleep() {
    const at = Sleep.at(), on = at > 0, left = Math.max(0, at - Date.now());
    if (!on && sleepSel.value !== '0') sleepSel.value = '0';
    if (on && !Sleep.fading() && document.activeElement !== sleepSel && sleepSel.dataset.at !== String(at)) {
      const mins = Math.ceil(left / 60000), opts = [...sleepSel.options].map(o => +o.value).filter(v => v > 0);
      sleepSel.value = String(opts.find(v => v >= mins) ?? opts[opts.length - 1]);
      sleepSel.dataset.at = String(at);
    }
    if (!on) delete sleepSel.dataset.at;
    for (const o of sleepSel.options) if (o.textContent !== o.dataset.label) o.textContent = o.dataset.label;
    if (on) {
      const sel = sleepSel.selectedOptions[0];
      const text = Sleep.fading() ? 'Sleep · Fading…' : 'Sleep · ' + Sleep.left();
      if (sel && sel.textContent !== text) sel.textContent = text;
    }
  }
  // Lock screen, Control Center and AirPlay remote: the channel's name and logo, play/pause, next/previous.
  let mediaKey = '';
  function paintMediaSession() {
    const ms = navigator.mediaSession, ch = S.current;
    if (!ms || !ch || mediaKey === ch.key) return;
    mediaKey = ch.key;
    try {
      ms.metadata = new MediaMetadata({ title: ch.name, artist: [countryOf(ch) ? countryName(countryOf(ch)) : '', groupLabel(ch)].filter(Boolean).join(' · '),
        album: 'video.sala.company', artwork: ch.logo ? [{ src: ch.logo }] : [] });
    } catch { /* older browsers */ }
  }
  if (navigator.mediaSession) {
    const on = (action, fn) => { try { navigator.mediaSession.setActionHandler(action, fn); } catch { /* not supported */ } };
    on('play', () => { if (liveState() !== 'live') playPause(); });
    on('pause', () => { if (liveState() === 'live') video.pause(); });
    on('nexttrack', () => step(1));
    on('previoustrack', () => step(-1));
  }
  function playPause() {
    const ch = S.current;
    if (!ch) return;
    const state = liveState();
    if (state === 'live') video.pause();
    else if (state === 'paused') video.play().catch(() => playChannel(ch));
    else if (state === 'tuning' || state === 'buffering') stopChannel();
    else playChannel(ch);
  }

  /* ---------- redraw loop: only what changed ---------- */
  function progressText() {
    if (!T.manual || (!T.active && !T.queue.length)) return '';
    return `Checked ${T.done} of ${T.total}`;
  }
  function refresh() {
    paintLive(); paintPresets(); paintRecent();
    const sig = [view, lang, country, genre, query, S.ui.currentId, S.channels.length, S.playlists.length, S.recent.length, S.recent[0]?.key,
      S.health.size, T.done, T.active, T.queue.length, S.rev, S.current?.key, S.loading, S.loadError].join('|');
    if (sig !== drawnSig) { drawnSig = sig; draw(); }
    const prog = progressText();
    if ($m('mTestProgress').textContent !== prog) $m('mTestProgress').textContent = prog;
    const running = T.manual && (T.active || T.queue.length);
    $m('mTest').textContent = running ? 'Stop testing' : 'Test channels';
  }

  /* ---------- wiring ---------- */
  $m('mChannelToggle').addEventListener('click', () => openBrowser(!browserOpen));
  $m('mBrowserClose').addEventListener('click', () => openBrowser(false));
  $m('mNavToggle').addEventListener('click', () => openNav(!navOpen));
  $m('mBackdrop').addEventListener('click', () => { openBrowser(false); openNav(false); });
  $m('mSettings').addEventListener('click', openSettings);
  $m('mPlay').addEventListener('click', playPause);
  $m('mRetry').addEventListener('click', () => S.current && playChannel(S.current));
  $m('mPrev').addEventListener('click', () => step(-1));
  $m('mNext').addEventListener('click', () => step(1));
  sleepSel.addEventListener('change', e => Sleep.set(+e.target.value));
  $m('mVolume').addEventListener('input', e => { video.volume = +e.target.value / 100; video.muted = +e.target.value === 0; });
  let searchTimer = 0;
  $m('mSearch').addEventListener('input', e => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { query = e.target.value.toLowerCase().trim(); refresh(); }, 150);
  });
  $m('mColumns').addEventListener('scroll', autoTestSoon, { capture: true, passive: true });
  $m('mTest').addEventListener('click', () => {
    if (T.manual && (T.active || T.queue.length)) return stopTests();
    const urls = testUrlsFor(items);
    if (!urls.length) return toast(items.length ? 'Everything listed was checked in the last 6 hours' : 'Nothing to test');
    if (urls.length > 1500 && !confirm(`Test ${urls.length} channels? This can take a while. Tip: pick a language, country or genre first.`)) return;
    queueTests(urls, { manual: true });
  });
  root.addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b || !root.contains(b)) return;
    const d = b.dataset;
    if (d.action) {
      const a = d.action;
      if (a === 'home') { openBrowser(false); openNav(false); }
      else if (a === 'settings') { openNav(false); openSettings(); }
      else if (a === 'add') { openNav(false); openAddDialog(); }
      else if (a === 'channels') setView('list');
      else setView(a);
      return;
    }
    if (d.addList !== undefined) return openAddDialog();
    if (d.act === 'seed') { S.ui.removedDefault = false; saveUi(); return ensureDefaultPlaylist(true); }
    if (d.list !== undefined) {
      if (d.list === '__recent__') { view = 'recent'; lang = country = genre = ''; refresh(); return scrollColumns(1); }
      view = 'list'; lang = country = genre = ''; query = ''; $m('mSearch').value = '';
      Promise.resolve(d.list === S.ui.currentId ? 0 : selectPlaylist(d.list)).then(refresh);
      return scrollColumns(1);
    }
    if (d.lang !== undefined) { lang = d.lang; country = genre = ''; refresh(); return scrollColumns(2); }
    if (d.country !== undefined) { country = d.country; genre = ''; refresh(); return scrollColumns(3); }
    if (d.genre !== undefined) { genre = d.genre; refresh(); return scrollColumns(4); }
    if (d.ch !== undefined) {
      const ch = items[+d.ch];
      if (ch) { chosenPreset = -1; playChannel(ch); openBrowser(false); }
      return;
    }
    if (d.recent !== undefined) { const r = S.recent[+d.recent]; if (r) { chosenPreset = -1; playChannel(channelFor(r)); } return; }
    if (d.preset !== undefined) {
      clearTimeout(holdTimer);
      if (held) { held = false; return; }
      const i = +d.preset, p = Presets.all()[i];
      if (p) { chosenPreset = i; playChannel(channelFor(p)); presetSig = ''; paintPresets(); }
      else toast('Long-press to save the channel that’s on here');
    }
  });
  // Long-press (650 ms) or Shift+Enter saves the channel that's on into a preset.
  const presetsEl = $m('mPresets');
  presetsEl.addEventListener('pointerdown', e => {
    const b = e.target.closest('[data-preset]');
    if (!b) return;
    held = false;
    clearTimeout(holdTimer);
    holdTimer = setTimeout(() => { held = true; assign(+b.dataset.preset); navigator.vibrate?.(30); }, 650);
  });
  for (const t of ['pointerup', 'pointercancel', 'pointerleave']) presetsEl.addEventListener(t, () => clearTimeout(holdTimer));
  presetsEl.addEventListener('contextmenu', e => { if (e.target.closest('[data-preset]')) e.preventDefault(); });
  presetsEl.addEventListener('keydown', e => {
    const b = e.target.closest('[data-preset]');
    if (b && e.key === 'Enter' && e.shiftKey) { e.preventDefault(); assign(+b.dataset.preset); }
  });
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape' || document.querySelector('dialog[open]')) return;
    if (navOpen) { e.preventDefault(); openNav(false); $m('mNavToggle').focus({ preventScroll: true }); }
    else if (browserOpen && overlayMode()) { e.preventDefault(); openBrowser(false); }
  });
  addEventListener('resize', () => {
    if (!overlayMode()) openNav(false);
    syncInert();
    if (browserOpen) fitMergedNames();
  });

  for (const ev of ['playing', 'pause', 'waiting']) video.addEventListener(ev, () => paintLive());
  root.classList.toggle('m-browser-open', browserOpen);
  $m('mChannelToggle').setAttribute('aria-expanded', String(browserOpen));
  syncInert();
  setInterval(() => { if (!document.hidden) refresh(); }, 900);
  refresh();
  // app.js calls sync() whenever the channels or their order change.
  return { refresh, openBrowser, live: () => paintLive(), sync() { drawnSig = ''; refresh(); } };
})();

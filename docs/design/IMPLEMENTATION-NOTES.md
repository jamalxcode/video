# video.sala.company: implementation and testing notes

**Updated:** 2026-11-10 · decisions: [DECISIONS.md](DECISIONS.md)

## Files
| File | Role |
|---|---|
| `index.html` | The screen's markup (now playing with the TV picture, presets, recently watched, picker, menu) and the dialogs. Loads `modern.css`, `app.js`, `modern.js`. |
| `app.js` | Engine: IndexedDB storage, playlists (several URLs per playlist, mirrors), M3U parsing and merging, languages, stream tester, playback (native HLS on AirPlay browsers, hls.js, mpegts.js, native), TV picture (test card, static, OSD), sleep timer, presets store, share links, backup, keyboard. |
| `modern.js` | The screen: picker (Collections → Languages → Countries → Genres → Channels), now playing, connection panel, presets, recently watched, menu, Media Session. Sets `S.filtered` so next / previous follow the picker. |
| `modern.css` | The screen and dialogs (radio design) plus the TV picture's retro styles. |
| `sw.js` | Offline shell. App files stale-while-revalidate; `lists/` never cached. Bump `CACHE` with each release (now `video-shell-v15`). |
| `lists/free-tv.m3u8` | Free-TV copy, refreshed daily by `.github/workflows/free-tv.yml`. |
| `mirror/mirror.js` | Cloudflare Worker that mirrors iptv-org for blocked networks (deployed separately). |

## How the pieces talk
- `S.rev` counts changes; `scheduleRender()` just bumps it. `modern.js` redraws every 0.9 s only what changed (signature of view, filters, playlist, health, tests, `S.rev`, current channel).
- `channelsChanged()` (app.js) → `Modern.sync()` when a playlist loads or refreshes.
- `TV.setState()` and the video element's playing / pause / waiting events repaint the connection panel immediately (`Modern.live()`).
- `S.note` carries why a channel didn't play (or "Trying backup source 2 of 3…") to the connection panel.
- `Presets` (app.js): 18 saved copies in IndexedDB `kv:presets`; `fill()` into empty slots, `sync()` refreshes their stream links from a loaded playlist; included in backups.
- Picker sorting: A–Z with `Intl.Collator({numeric: true})` ignoring leading punctuation, computed once per channel set. Countries A–Z by displayed name; genres A–Z; languages A–Z with Unknown last. Countries and genres merge 1–2-channel entries into groups of 6+ (`mergeSmall`); merged counts are recounted so a channel is counted once. Languages are never merged.
- Language flags: `LANG_HOME` in `modern.js` (ISO 639 code → home country). Duplicate codes merged by `LANG_SAME` in `app.js`.
- Asset versions in `index.html`: `modern.css?v=3`, `app.js?v=36`, `modern.js?v=9`; bump when the file changes.

## Testing done (headless Chromium via Playwright; sandbox blocks real TV streams)
- Layout at phone 390×844, fold 1100×800, tablet 820×1100, desktop 1440×900; no console errors.
- Real playback with a local test stream (WebM served with CORS): live state, pause / resume, a dead source handing over to the backup, No signal + Retry, rating, source menu, channel-number keys, settings, backup export / import, Free-TV quick add (also with GitHub and jsDelivr blocked), removing a playlist.
- Picker: all 905 country × genre combinations list only matching channels A–Z with matching counts; 123+ languages and 305 language × country × genre combinations; every row's count equals what it lists in all three filter columns; Persian → United States includes High Vision TV.
- Presets: long-press save, persistence across reload, favorites → presets migration, share-presets link round trip, stale preset links refreshed.
- ESLint `no-undef` clean across `app.js` + `modern.js`; every element the scripts look up exists.

## Not verified
- Real devices (iPhone Safari, Samsung Fold, Apple TV via AirPlay) after the redesign.
- Real streams on the open internet from these builds (the sandbox blocks them).
- Each GitHub Pages deploy was usually seen starting; completion of the last few wasn't checked.

## Working rules used
- Plain HTML / CSS / JS, no build step.
- Don't delete user data without a migration plan (favorites → presets is the model: one-time, additive, flagged in `S.ui.favsToPresets`).
- Bump the asset `?v=` and the service-worker `CACHE` with each release.

# CLAUDE.md

This file guides Claude Code when working in this repository.

## Overview

video.sala.company (live at https://video.sala.company) is a browser IPTV player for M3U/M3U8 playlists, styled as a retro TV next to a radio.sala.company-style navy/brushed-metal UI with a Finder-style channel picker. With no playlist it auto-loads iptv-org combined with Free-TV (about 12,300 channels). It is plain HTML/CSS/vanilla JS with no build step and no package.json; playback uses hls.js and mpegts.js from jsDelivr plus native `<video>`.

## Commands

There are no build, test or lint scripts in the repo. Serve the directory statically to run locally, e.g.:

```
python3 -m http.server 8000
```

`?m3u=<playlist-url>` on the page URL adds that playlist automatically. Previous testing (per `docs/design/IMPLEMENTATION-NOTES.md`) was done ad hoc with headless Chromium/Playwright and ESLint `no-undef`; none of that tooling is checked in.

## Architecture

- `index.html`: markup for the screen (now playing + TV picture, presets, recently watched, picker, menu) and dialogs. Loads `modern.css`, `app.js`, `modern.js`, then registers `sw.js` and the GoatCounter snippet.
- `app.js`: the engine: IndexedDB storage (`indexedDB.open('m3u-player', 2)`; presets under `kv:presets`), playlists (several space-separated URLs per playlist, merged), M3U parsing/merging, languages (`LANG_SAME` merges duplicate ISO codes), the stream tester, playback (native HLS on AirPlay-capable Safari, hls.js, mpegts.js, native), TV picture (test card, static, OSD), sleep timer, `Presets` (18 slots), share links (data after `#`), backup export/import, keyboard.
- `modern.js`: the screen: picker (Collections -> Languages -> Countries -> Genres -> Channels), now playing/connection panel, presets, recently watched, menu, Media Session. `LANG_HOME` maps language codes to flag countries. Redraws every 0.9 s based on a change signature; `S.rev` / `scheduleRender()` / `channelsChanged()` -> `Modern.sync()` are the hooks between the two files.
- `modern.css`: screen and dialog styles plus the retro TV effects.
- `sw.js`: offline shell. Page is network-first (4 s timeout, then cache); same-origin app files stale-while-revalidate; CDN libs (hls.js, mpegts.js, flag polyfill, Google Fonts) cache-first; `lists/` and all streams/iptv-org/mirror requests are never cached.
- `lists/free-tv.m3u8`: same-origin copy of the Free-TV playlist (works where raw.githubusercontent.com is blocked; jsDelivr can't serve it).
- `mirror/mirror.js`: Cloudflare Worker that proxies/caches iptv-org playlist and API files for 6 h. Deployed separately to Cloudflare (no wrangler config in repo); not part of the Pages site.
- iptv-org downloads race up to seven sources (iptv-org.github.io, the Worker, raw.githubusercontent.com, jsDelivr hosts, githack), staggered by 3 s; first good response wins.
- `sample.m3u`: example playlist. `docs/design/`: DECISIONS.md and IMPLEMENTATION-NOTES.md (read these before larger changes). `docs/conversations/`: request history.

All user data (playlists, presets, ratings, test results, settings) lives in the browser's IndexedDB; nothing is uploaded.

## Deployment

- GitHub Pages serves the `main` branch root (no Pages build workflow). Pushing to `main` deploys live. `.nojekyll` is present.
- Custom domain `video.sala.company` via `CNAME`.
- `.github/workflows/free-tv.yml` ("Refresh Free-TV copy") runs daily (and on dispatch): downloads Free-TV's `playlist.m3u8`, sanity-checks it (`#EXTM3U` header, >= 500 `#EXTINF`), commits `lists/free-tv.m3u8` if changed, then triggers a Pages build via `gh api` (bot pushes don't start one on their own). Expect bot commits on `main`; pull before pushing.

## Conventions and gotchas

- With each release bump BOTH:
  - asset query strings in `index.html` (currently `modern.css?v=3`, `app.js?v=36`, `modern.js?v=9`) for the files that changed, and
  - `CACHE` in `sw.js` (currently `video-shell-v15`).
  Otherwise returning visitors keep stale files.
- If you add a new app file, add it to `SHELL` in `sw.js`.
- Keep the GoatCounter snippet at the end of `index.html` intact (endpoint `https://salacompany.goatcounter.com/count`, skipped on localhost, path prefixed with `location.host`).
- Don't delete or reshape user data without a one-time, additive migration (favorites -> presets is the model, flagged in `S.ui.favsToPresets`).
- Browser limits are expected, not bugs: HTTP streams on an HTTPS page, CORS-blocked servers (marked Blocked), custom User-Agent/Referer headers can't be set.
- Mobile matters: phones get a hamburger menu and the picker slides over the screen; no volume slider on phones. Check phone (~390px) and desktop layouts.
- The pre-redesign version is kept on the remote branch `backup/pre-redesign-2026-11-09` (per README).

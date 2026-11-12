# video.sala.company: implementation and testing notes

**Updated:** 2026-11-12 · decisions: [DECISIONS.md](DECISIONS.md)

## Files
| File | Role |
|---|---|
| `index.html` | The screen's markup (now playing with the TV picture, presets, recently watched, picker, menu) and the dialogs. Loads `modern.css`, `app.js`, `modern.js`. |
| `app.js` | Engine: IndexedDB storage, playlists (several URLs per playlist, mirrors), M3U parsing and merging, languages, stream tester, playback (native HLS on AirPlay browsers, hls.js, mpegts.js, native), TV picture (test card, static, OSD), sleep timer, presets store, share links, backup, keyboard. |
| `modern.js` | The screen: picker (Collections → Languages → Countries → Genres → Channels), now playing, connection panel, presets, recently watched, menu, Media Session. Sets `S.filtered` so next / previous follow the picker. |
| `modern.css` | The screen and dialogs (radio design) plus the TV picture's retro styles. |
| `sw.js` | Offline shell. App files stale-while-revalidate; `lists/` never cached. Bump `CACHE` with each release (now `video-shell-v17`). |
| `manifest.webmanifest`, `icon-192.png`, `icon-512.png`, `icon-maskable-512.png` | Installable app (rendered from `favicon.svg`). |
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
- Asset versions in `index.html`: `modern.css?v=5`, `app.js?v=36`, `modern.js?v=11`; bump when the file changes.

## Devices (modern.js `layout()`, the "Devices" section at the end of modern.css)
- Root classes set by `layout()`: `m-rail` (landscape and height ≤ 560 px, `RAIL` query), `m-dual-h` / `m-dual-v` (two `window.viewport.segments`, side by side / stacked). CSS keys off these classes; `--seg-first` and `--seg-hinge` give the first pane's size and the hinge's, measured from the segments relative to the shell (so safe-area padding is accounted for).
- `overlayMode()` (picker covers the screen) and `navOverlay()` (menu is a drawer) depend on the mode; `syncInert()` makes whatever is covered `inert`.
- `openBrowser(open, auto)`: `pickerChoice` remembers your own choice; folds open the picker with `auto` and restore `pickerChoice` when folding back.
- Re-run on `resize`, `orientationchange`, `segmentschange`, the segment / wide / rail media queries changing, and `navigator.devicePosture` changes.
- `#modernApp` is padded by `env(safe-area-inset-*)` on all four sides; `--kb` (keyboard overlap from `visualViewport`) lifts dialogs and the toast.
- Session state: `sessionStorage['video-screen']` (view, language, country, genre, search, picker open, details open, column and page scroll), saved every 5 s, on `pagehide` and when hidden; restored at start, scroll once channels are listed.
- Touch: `@media (pointer: coarse)` sets 44 px minimums and 16 px inputs; hides volume.

## Testing done (headless Chromium via Playwright; sandbox blocks real TV streams)
- Layout at phone 390×844, fold 1100×800, tablet 820×1100, desktop 1440×900; no console errors.
- Real playback with a local test stream (WebM served with CORS): live state, pause / resume, a dead source handing over to the backup, No signal + Retry, rating, source menu, channel-number keys, settings, backup export / import, Free-TV quick add (also with GitHub and jsDelivr blocked), removing a playlist.
- Picker: all 905 country × genre combinations list only matching channels A–Z with matching counts; 123+ languages and 305 language × country × genre combinations; every row's count equals what it lists in all three filter columns; Persian → United States includes High Vision TV.
- Presets: long-press save, persistence across reload, favorites → presets migration, share-presets link round trip, stale preset links refreshed.
- ESLint `no-undef` clean across `app.js` + `modern.js`; every element the scripts look up exists.

## Device testing (2026-11-11; Chromium 153 with CDP `Emulation.setSafeAreaInsetsOverride` and `setDeviceMetricsOverride` `displayFeature`)
- Eight emulated devices: iPhone portrait (59/34 insets), iPhone landscape (59 left and right), a Duo-style outer display (52 px island on the left, 24 px system UI on the right), an unfolded Duo-style screen with a 20 px vertical hinge, a top/bottom fold with a 24 px hinge, a small Android phone, a tablet and a desktop. For each, picker closed and open: no pane outside the safe area, nothing under a hinge, no sideways scrolling, the picker never over the rail, every touch control ≥ 44 px.
- Transitions while a local test stream played: portrait → landscape → outer display → unfolded → top/bottom → portrait → unfolded → landscape → portrait. Playback never paused or restarted, and the channel, search, filtered list and presets stayed the same; folding back returned the picker to its previous state. Reload restored the picker's search and filters.
- Settings dialog on a 390 px tall landscape screen, with and without a 180 px keyboard: inside the safe area and above the keyboard, scrolling inside, Save visible.
- Earlier suites re-run: playback / backup sources / settings / backup / playlists, picker counts, presets sharing. ESLint `no-undef` clean.
- Two test-harness traps (not app bugs): Playwright's own viewport and screenshot calls reset an emulated hinge; set the viewport first, then the CDP override, and use CDP `Page.captureScreenshot`.

## Picker sideways scrolling fix (2026-11-11, same as radio.sala.company's)
- Columns had `overscroll-behavior: contain` on both axes, which also swallowed sideways swipes that started on a column, so on phones and folds the row of columns couldn't be swiped to the channels. Now `overscroll-behavior: auto contain` (only up/down contained).
- A redraw during the slide to the next column (channels loading, checks finishing) restored the mid-slide position and stopped it. `scrollColumns()` stores the target in `holder._goal` (1.5 s) and `draw()` finishes it.
- Narrow screens (≤ 1049 px): the channels column fills what the genres column leaves (`container-type: inline-size`, `width: clamp(244px, 100cqw − 155px, 380px)`; 228 px / 145 px under 620 px), so names show in full.
- Tested with CDP touch swipes (`Input.dispatchTouchEvent` start / moves / end with `hasTouch` + `isMobile`) at 390, 476 and 700 px; in this setup they did scroll (the radio session found synthesized gestures didn't scroll for it and used `page.mouse.wheel(dx, 0)`, which follows the same scroll-chaining rules; either works as a check): before, a swipe on a column moved the row 0 px and a country tap plus a mid-slide refresh left the channels column partly off screen; after, the swipe moves the row and the channels column ends fully on screen. Device matrix, fold transitions and picker counts re-run.

## Not verified
- Real devices (iPhone Safari, iPhone Duo, Samsung Fold, Apple TV via AirPlay) after the redesign. Whether Safari on the iPhone Duo reports its hinge as screen segments is unknown.
- Real streams on the open internet from these builds (the sandbox blocks them).
- Each GitHub Pages deploy was usually seen starting; completion of the last few wasn't checked.

## Working rules used
- Plain HTML / CSS / JS, no build step.
- Don't delete user data without a migration plan (favorites → presets is the model: one-time, additive, flagged in `S.ui.favsToPresets`).
- Bump the asset `?v=` and the service-worker `CACHE` with each release.

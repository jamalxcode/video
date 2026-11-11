# video.sala.company

Live at **https://video.sala.company** · part of [Sala Company](https://go.sala.company), free apps that run in your browser

A browser-based player for M3U / M3U8 IPTV playlists. It's a static site, so it can be hosted for free on GitHub Pages.

## The screen

The layout and channel picker follow [radio.sala.company](https://radio.sala.company) (navy, brushed-metal panels), with the retro TV picture kept: test card when idle, static between channels, the green on-screen channel number and the cable-guide style messages.

- **Now playing:** the TV picture, then the channel with its flag, number, country, genre and language, and a large Play/Pause button. Below it the real connection status ("Connecting…", "Connected · On air · Source 1 of 2 · HLS · 720p", "No signal" with the reason and a Retry button).
- **Sleep, channel up/down and volume:** one sleep selector (15 minutes to 3 hours, with a live countdown and **Sleep Off**; at zero the sound fades out), ◀ CH / CH ▶ buttons, and a volume slider (not on phones, where the phone's own buttons work).
- **Channel details, sources and rating:** pick a channel's source by hand, rate it (Smooth / Buffers / Broken), test it, copy its link for VLC, and see its play and test history.
- **Presets:** 18 slots with channel logos. Tap to play; long-press (or Shift+Enter) saves the channel that's on. Only the slot you picked is highlighted, even if a channel is saved twice. Presets are saved copies; when a playlist loads they pick up their channel's latest stream links. Presets replace favorites: saved favorites moved once into the empty slots, and favorites in old backups and old share links do the same (any that don't fit are added as a playlist).
- **Recently watched:** the last channels you actually watched.
- **Channels** (the TV button, with a sweeping red scanner light): a Finder-style picker with Collections → Languages → Countries → Genres → Channels, all A–Z. Collections holds your playlists, ◷ Recently watched and ＋ Add playlist. Languages come from the playlist or iptv-org's channel data (a channel with several languages is under each; ones with none are under Unknown, last). The country is where the channel is registered, so a Persian channel run from Los Angeles is under United States; pick a language first to find those. Every language has its own row, with the flag of the country it started in (English 🇬🇧, Arabic 🇸🇦, Spanish 🇪🇸); languages with no country of their own (Kurdish, Romani, Tibetan, Uyghur, Serbo-Croatian) have none. Two codes for the same language (Dutch `dut`/`nld`, French `fre`/`fra`…) count as one. Countries and genres with only 1–2 channels are merged into groups of six or more, and a merged row counts each channel once. Search matches channel names, countries, genres and languages. Channels on screen are checked quietly; a silver ✓ marks channels a real test or play showed working. Picking a channel plays it and returns to the TV; on phones the picker slides over the screen. *Test channels* checks everything listed. Next / previous channel follow what the picker lists.
- **Menu (☰ on phones, a sidebar on wider screens):** Home, Recently watched, Channel browser, Add playlist, Settings.
- **Settings (⚙):** skip failed channels, retro screen effects, quiet checks, advanced timings; refresh, share or remove the open playlist; share presets; backup export/import (presets included); clear test history; erase everything.

## Features

- **Ready to watch**: whenever there is no playlist, the full [iptv-org](https://github.com/iptv-org/iptv) list combined with [Free-TV](https://github.com/Free-TV/IPTV) (a hand-picked list of free channels) loads by itself: about 12,300 channels. A channel that's in both lists becomes one channel with backup sources. If you remove it with 🗑, it isn't added again. People who already had the iptv-org-only list get Free-TV added to it automatically.
- **Combined playlists**: a playlist URL can hold several lists separated by spaces; they're downloaded together and merged. The Add dialog has quick picks for iptv-org + Free-TV, iptv-org alone, Free-TV alone, or one iptv-org country. Free-TV loads from this site's own copy (`lists/free-tv.m3u8`, refreshed daily by the *Refresh Free-TV copy* GitHub Action), so it works wherever the player loads, even where raw.githubusercontent.com is blocked; jsDelivr can't serve Free-TV because its repo is over jsDelivr's 50 MB limit. Other GitHub-hosted lists fall back to jsDelivr and githack copies.
- **Works on networks that block iptv-org**: every iptv-org download (the channel list, the country lists, the language data) is fetched from seven sources in a race: iptv-org.github.io, this site's own Cloudflare Worker (`mirror/mirror.js` at video-mirror.jamal-akuna-matata.workers.dev, which fetches from iptv-org and keeps a copy for six hours), raw.githubusercontent.com, jsDelivr (three hosts) and githack. Each waits 3 seconds for the previous one before starting, the first good answer wins and the rest are cancelled. If all seven fail, the player retries on its own (after 5 s, 15 s, 30 s, then every minute) and as soon as the network comes back.
- **Load playlists** from a URL, an uploaded file, or pasted text, or quick-add iptv-org, Free-TV or any iptv-org country list. You can keep several playlists and switch between them.
- **Plays** HLS (`.m3u8`) with hls.js, MPEG-TS/FLV with mpegts.js, and MP4/WebM with the browser's own player.
- **AirPlay to Apple TV**: on iPhone, iPad and Mac Safari, HLS channels play in Safari's own player, so the AirPlay button in the player sends the channel straight to an Apple TV (the Apple TV fetches the stream itself, and you can lock your phone). Raw TS/FLV channels can't be AirPlayed this way; use Screen Mirroring for those.
- **Status before you click.** Every channel in the picker shows a mark on its name line:
  - silver **✓ Verified working**: a test or a real play showed it streams well (or you rated it Smooth)
  - **! Slow**: slow to respond, video downloads close to real-time speed, or it buffered a lot when you watched it
  - **×** Unavailable or Blocked: offline or failed when you tried it, or the server doesn't allow web players (CORS or HTTP-only)
  - **?** not checked yet, **◌** being checked now
- **Testing**: channels on screen in the picker are tested automatically (you can turn this off). *Test channels* checks everything the picker lists. Tests are light: each reads only a small sample of video, runs at most 2 at a time per server, and skips servers already known to block browsers. Results stay valid for 6 hours.
- **Always current**: playlists added from a URL are quietly re-downloaded once a day.
- **Learns from watching**: start time, failures and buffering are recorded every time you play a channel.
- **Your own ratings**: 👍 Smooth / ⚠ Buffers / ✖ Broken. Your rating always beats test results.
- **Presets** work across all your playlists.
- **Country and language**: every channel shows its country flag before its name and its language(s) underneath (e.g. ARA·FRA). For iptv-org channels the country comes from the channel id and the language from iptv-org's channel data (refreshed every few days); other playlists can provide `tvg-country` and `tvg-language`. Flags use a small flags-only font so they also show on Windows.
- **Playlist warnings**: channels iptv-org marks as geo-blocked or not on air 24/7 get GEO / PART-TIME tags, and those sources are tried last.
- **Recently watched**: the last 40 channels you actually watched, from any playlist.
- **Remembers volume** and mute between channels and visits.
- **Auto-skip** (in Settings): jumps to the next working channel when one fails or times out.
- **Sleep timer**: the sleep selector (or `S`, which adds 30 minutes at a time up to 3 hours, then off). At the end the sound fades out over 10 seconds and the channel stops, with a button to resume.
- **Every device**: phones, tablets, foldables (including the iPhone Duo, folded and unfolded) and desktops. The layout keeps clear of notches, Dynamic Islands and side system bars on any edge; landscape phones and narrow outer displays get a vertical side rail; on a folding screen the TV and the channel picker each get their own screen and nothing sits under the hinge. Folding, rotating or resizing never interrupts the channel, and your place in the picker survives a reload. Installable as an app (Add to Home Screen / Install).
- **Lock screen and AirPlay remote**: the channel's name and logo show in Control Center and on the lock screen, with play/pause and next/previous channel (where the browser supports it).
- **Keyboard / TV remote**: ↑↓ or ←→ previous/next channel, type a channel number to jump, `S` sleep timer, Space pause, Esc closes the menu or picker.
- **Retro picture**: scanlines and static between channels can be switched off in Settings.

## Share links

Settings → **Share presets** / **Share this playlist** makes a link (after the `#`, so nothing is sent to any server) that carries your preset channels, or a playlist, to another phone or person; opening it offers to add them (presets go into empty preset slots). Playlists from a URL share the URL; pasted or uploaded ones are carried in the link when they fit.

## Works offline

The app's own files are kept in the browser by a small service worker (`sw.js`), so the site opens instantly and still opens with no network, showing your playlists and presets (streams need network). The page itself is fetched fresh when the network answers within 4 seconds, so updates arrive normally.

## Your data stays in your browser

Playlists, presets, ratings, test results and settings are stored in the browser's IndexedDB. Nothing is uploaded anywhere, so every person and every browser has its own separate list. To move your data to another device, use **⚙ → Export backup**, then **Import backup** on the other device.

## Design notes

- [Design decisions](docs/design/DECISIONS.md): what was decided and why (AirPlay, Free-TV, the radio-style screen, presets only, languages and flags).
- [Implementation and testing notes](docs/design/IMPLEMENTATION-NOTES.md): how the pieces fit, what was tested, what wasn't.
- [Conversation record](docs/conversations/2026-11-02_to_2026-11-11.md): the requests behind each change.
- The design before the 2026-11-09 redesign is kept on the branch `backup/pre-redesign-2026-11-09`.

## Code

Plain HTML, CSS and JS, with no build step.

| File | What's in it |
|---|---|
| `app.js` | Storage, playlists, parsing, the stream tester, playback (hls.js / mpegts.js / native), the TV picture (test card, static, on-screen display), sleep timer, presets, share links, backup, keyboard |
| `modern.js` | The screen: now playing, presets, recently watched, the channel picker, menu |
| `modern.css` | The screen and its dialogs, and the TV picture's retro styles |
| `sw.js` | Offline shell |


## Put it on GitHub Pages

1. Create a new repository on GitHub, for example `m3u-player`.
2. Upload `index.html`, `modern.css`, `app.js`, `modern.js`, `sw.js`, the icons and `.nojekyll`. `sample.m3u` is optional.
3. In the repository, go to **Settings → Pages**. Under **Source**, choose **Deploy from a branch**, pick `main` and `/ (root)`, and save.
4. After a minute the site is live at `https://<your-username>.github.io/m3u-player/`.

Tip: `https://<you>.github.io/m3u-player/?m3u=<playlist-url>` opens the player and adds that playlist automatically.

## Known browser limits

These apply to every web-based player, not only this one:

- **Plain `http://` streams**: GitHub Pages is HTTPS, and browsers block HTTP video on HTTPS pages. The player tries the `https://` version of the link automatically. If the server doesn't support HTTPS, the channel is marked *Blocked*.
- **CORS**: some servers only allow apps like VLC and refuse web pages. These are marked *Blocked*. Use **Copy link** to open them in VLC instead.
- **Custom headers**: playlists that need a special User-Agent or Referer (`#EXTVLCOPT`, `|User-Agent=`) can't be honored, because browsers don't let pages set those headers.
- Test results are a snapshot. A channel that's fine now can be overloaded at peak time, so the player also remembers how each channel behaved when you actually watched it.

Only use playlists you're allowed to watch.

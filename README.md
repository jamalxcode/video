# video.sala.company

Live at **https://video.sala.company** · part of [Sala Company](https://go.sala.company), free apps that run in your browser

A browser-based player for M3U / M3U8 IPTV playlists, styled like a 70s wood-panel TV with an 80s cable TV guide. It's a static site, so it can be hosted for free on GitHub Pages.

## Features

- **Ready to watch**: on the first visit the full [iptv-org](https://github.com/iptv-org/iptv) list (about 11,000 public channels) loads automatically. If you remove it, it isn't added again.
- **Load playlists** from a URL, an uploaded file, or pasted text, or quick-add any iptv-org country list. You can keep several playlists and switch between them.
- **Plays** HLS (`.m3u8`) with hls.js, MPEG-TS/FLV with mpegts.js, and MP4/WebM with the browser's own player.
- **Grey until proven good.** Every channel starts grey and lights up guide blue once a test or a real play shows it streams well. While channels are being checked, rows say *Checking…* or *Queued* and a scanning bar runs above the guide.
- **Warnings before you click.** Every channel shows a badge:
  - 🟢 **Good**: tested fast, or it played fine for you last time
  - 🟡 **Slow / Buffers**: slow to respond, video downloads close to real-time speed, or it buffered a lot when you watched it
  - 🔴 **Broken**: offline, missing, or failed when you tried it
  - ⭕ **Blocked**: the server doesn't allow web players (CORS or HTTP-only), so it usually won't work in any browser
- **Backup sources**: when a playlist lists the same channel more than once (different qualities or sources), it becomes one channel. The best source plays first, and if it fails or hangs the next one takes over automatically. You can also pick a source by hand.
- **Testing**: channels are tested automatically as you scroll (you can turn this off). *Test channels* checks the whole current list or group. Tests are light: each reads only a small sample of video, runs at most 2 at a time per server, and skips servers already known to block browsers. Results stay valid for 6 hours.
- **Sort**: playlist order, best first, or name.
- **Always current**: playlists added from a URL are quietly re-downloaded once a day.
- **Learns from watching**: start time, failures and buffering are recorded every time you play a channel.
- **Your own ratings**: 👍 Smooth / ⚠ Buffers / ✖ Broken. Your rating always beats test results.
- **Favorites** (★) work across all your playlists.
- **Country and language**: every channel shows its country flag before its name and its language(s) underneath (e.g. ARA·FRA). For iptv-org channels the country comes from the channel id and the language from iptv-org's channel data (refreshed every few days); other playlists can provide `tvg-country` and `tvg-language`. Flags use a small flags-only font so they also show on Windows.
- **Filters**: search, country, language, group, Working only, Hide broken, Hide geo-blocked, Untested.
- **Playlist warnings**: channels iptv-org marks as geo-blocked or not on air 24/7 get GEO / PART-TIME tags, and those sources are tried last.
- **Recently watched**: the last 40 channels you actually watched, from any playlist.
- **Remembers volume** and mute between channels and visits.
- **Auto-skip** (in Settings): jumps to the next working channel when one fails or times out.
- **Sleep timer**: the ☾ SLEEP knob counts down from 30 minutes to 3 hours (each press adds 30 minutes, then off). At the end the sound fades out over 10 seconds and the channel stops, with a button to resume.
- **Keyboard / TV remote**: ↑↓ move through the guide, Enter plays, ←→ previous/next channel, PgUp/PgDn jump a page, type a channel number to jump, `F` favorite, `S` sleep timer, Space pause, Esc back to what's playing.
- **Retro look**: wood-cabinet TV with a channel dial on desktop, a full-width player with a control strip on phones. Scanlines and static between channels can be switched off in Settings.

## Your data stays in your browser

Playlists, favorites, ratings, test results and settings are stored in the browser's IndexedDB. Nothing is uploaded anywhere, so every person and every browser has its own separate list. To move your data to another device, use **⚙ → Export backup**, then **Import backup** on the other device.

## Put it on GitHub Pages

1. Create a new repository on GitHub, for example `m3u-player`.
2. Upload `index.html`, `style.css`, `app.js` and `.nojekyll`. `sample.m3u` is optional.
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

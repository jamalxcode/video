# M3U Player

A browser-based player for M3U / M3U8 IPTV playlists. It's a static site, so it can be hosted for free on GitHub Pages.

## Features

- **Load playlists** from a URL, an uploaded file, or pasted text. You can keep several playlists and switch between them.
- **Plays** HLS (`.m3u8`) with hls.js, MPEG-TS/FLV with mpegts.js, and MP4/WebM with the browser's own player.
- **Warnings before you click.** Every channel shows a badge:
  - 🟢 **Good**: tested fast, or it played fine for you last time
  - 🟡 **Slow / Buffers**: slow to respond, video downloads close to real-time speed, or it buffered a lot when you watched it
  - 🔴 **Broken**: offline, missing, or failed when you tried it
  - ⭕ **Blocked**: the server doesn't allow web players (CORS or HTTP-only), so it usually won't work in any browser
- **Testing**: channels are tested automatically as you scroll (you can turn this off). *Test channels* checks the whole current list or group.
- **Learns from watching**: start time, failures and buffering are recorded every time you play a channel.
- **Your own ratings**: 👍 Smooth / ⚠ Buffers / ✖ Broken. Your rating always beats test results.
- **Favorites** (★) work across all your playlists.
- **Filters**: search, group, Working only, Hide broken, Untested.
- **Auto-skip** (in Settings): jumps to the next working channel when one fails or times out.
- **Keyboard**: ↑/↓ change channel, `F` toggles favorite.

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

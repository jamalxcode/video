# 📺 video.sala.company

**Live at https://video.sala.company** · part of [Sala Company](https://go.sala.company), free apps that run in your browser

Remember when a TV was a wooden box with rabbit ears, and changing the channel meant getting off the sofa? This is that feeling, minus the sofa part. Open the page and about **12,400 free TV channels** from around the world load by themselves: news, cooking shows, anime, weather, and the occasional shopping channel in a language you don't speak. No account, no app store, no subscription. It's a web page.

Under the hood it's a player for M3U / M3U8 IPTV playlists, built from plain HTML, CSS and JavaScript with no build step, hosted for free on GitHub Pages.

---

## The tour

### The TV
The picture is a little time machine. When nothing's on you get the classic **colour-bar test card**. Change channel and you get **static**, then a green **CH 378** in the corner like an old set. When a stream gives up, a cable-company style **NO SIGNAL** box says why, with Next channel, Retry and Copy link for VLC. Scanlines included (switchable in Settings if you're not feeling nostalgic).

Around it is a modern navy, brushed-metal control panel, borrowed from our sister site [radio.sala.company](https://radio.sala.company), so the two feel like a matching hi-fi set.

### Now playing
- The channel's flag, name, number, country, genre and language, plus a big **Play / Pause** button.
- A **connection panel** that tells the truth: "Connecting…", "Trying backup source 2 of 3…", "Connected · On air · Source 1 of 2 · HLS · 720p", or "No signal" with the actual reason and a Retry button.
- **Sleep timer**: one menu from 15 minutes to 3 hours, with a live countdown. At zero the sound fades out over 10 seconds, like a polite parent turning off the TV.
- **◀ CH / CH ▶** for good old channel surfing.
- **Channel details**: pick a source by hand, rate it (👍 Smooth / ⚠ Buffers / ✖ Broken), test it, copy its link, and see how it's behaved for you before.

### 18 presets
Like the buttons on a car radio. Tap to watch; long-press (or Shift+Enter) to save whatever's on. They work across all your playlists, they keep their stream links fresh when a playlist reloads, and only the button you pressed lights up, even if you saved the same channel twice. (Favorites retired in their favour; any you had moved into the empty slots.)

### The channel picker
Hit the **Channels** button, the one with the red light sweeping back and forth like a certain talking car. Out slides a Finder-style browser:

**Collections → Languages → Countries → Genres → Channels**

- **Languages** each get their own row and the flag of the country the language started in: 🇬🇧 English, 🇸🇦 Arabic, 🇪🇸 Spanish, 🇮🇷 Persian. (Kurdish, Romani, Tibetan, Uyghur and Serbo-Croatian have no single home country, so no flag.)
- **Countries** are where a channel is registered, not what it speaks. That's why Korean-language MBC America and Persian High Vision TV live under 🇺🇸 United States (both broadcast from Los Angeles). Pick a language first to find them.
- Tiny countries and genres (1–2 channels) are bundled into groups of six or more, so the lists stay short.
- Everything is A–Z, numbers sorted like a human would (2 before 10).
- Search matches names, languages, countries and genres.
- On a phone, swipe sideways from anywhere on the columns. After you choose a country, the Channels column stretches to fill the screen so names show in full.

Every channel wears a little badge on its name line:

| Badge | Meaning |
|---|---|
| silver **✓** | Verified working: a test or a real play showed it streams well (or you rated it Smooth) |
| **! Slow** | Slow to start, or it buffered a lot when you watched |
| **×** | Offline, failed, or the server doesn't allow web players |
| **?** | Not checked yet |
| **◌** | Being checked right now |

The picker quietly checks the channels on screen as you scroll. Each check reads only a tiny sample of video, never more than 2 at a time per server, and results stay fresh for 6 hours.

---

## Fun things it does

- **Sends TV to your Apple TV.** On an iPhone, iPad or Mac, tap the AirPlay button in the player. Safari hands the stream to the Apple TV, which fetches it itself, so you can lock your phone and carry on. (No developer account, no app: just AirPlay.)
- **Works on every screen we could think of**, including the iPhone Duo, folded and unfolded. On a phone in landscape, or a narrow outer screen, the menu becomes a vertical toolbar down the side. On a folding screen the TV gets one half and the channel picker gets the other, with nothing hiding under the hinge. Notches, Dynamic Islands and side-mounted system bars are kept clear on every edge.
- **Never drops the channel when you fold, rotate or resize.** The layout reshuffles around the video without stopping it, and your place in the picker survives a page reload.
- **Has backup plans for its backup plans.** When the same channel appears in two lists, it becomes one channel with backup sources. If one source fails, the next takes over by itself.
- **Gets past networks that block things.** The channel list is fetched from seven places in a staggered race: iptv-org.github.io, our own Cloudflare Worker, raw.githubusercontent.com, three jsDelivr hosts and githack. The first good answer wins. If they all fail, it keeps retrying and jumps back in the moment your connection returns. Free-TV loads from a copy on this very site, refreshed daily by a GitHub Action.
- **Learns from watching.** Start times, failures and buffering are remembered, so the sources that work for *you* are tried first next time. Your own ratings always win over automated tests.
- **Knows a remote when it sees one.** Arrow keys change channel, typing a number jumps to it (like punching in 4078), Space pauses, S sets the sleep timer, Esc closes the menu or picker. Lock-screen and Control Center controls work too, with the channel's name and logo.
- **Installs like an app.** Add to Home Screen on iPhone or Install in Chrome and it opens full screen with its own little TV icon.
- **Works offline-ish.** The app itself opens with no network, showing your playlists and presets (the channels themselves still need the internet, sadly).

---

## Where the channels come from

- **[iptv-org](https://github.com/iptv-org/iptv)**: the big public list of freely available channels worldwide.
- **[Free-TV](https://github.com/Free-TV/IPTV)**: a hand-picked list of channels that are free to watch, adding about 1,400 more (lots of Italy, Greece, Hungary and Pluto TV).
- **Your own:** paste a playlist URL (several, separated by spaces, are merged into one), upload a file, or paste the text. `?m3u=<playlist-url>` on the page address adds one from a link (it asks first).

Playlists from a URL refresh themselves once a day. Only use playlists you're allowed to watch.

## Share it

Settings → **Share presets** or **Share this playlist** makes a link that carries your channels to another phone or person. Everything rides after the `#` in the link, so nothing passes through any server. Opening it offers to add them (presets drop into empty slots).

## Your data stays yours

Playlists, presets, ratings, test results and settings live in your browser's IndexedDB. Nothing is uploaded, there are no accounts, and every browser has its own private setup. Moving to a new device? **⚙ → Export backup**, then **Import backup** on the other one.

## Honest limits

These apply to any player that runs in a web page, not just this one:

- **Plain `http://` streams**: browsers block them on secure (HTTPS) pages. The player tries the `https://` version first; if the server doesn't have one, the channel is marked Blocked.
- **CORS**: some servers only talk to apps like VLC and refuse web pages. They're marked Blocked; use **Copy link** and open them in VLC.
- **Special headers**: a few playlists need a custom User-Agent or Referer, which browsers don't let web pages send.
- **AirPlay**: works for HLS channels; raw TS / FLV ones need Screen Mirroring instead.
- **Test results are a snapshot**: a channel that's fine at noon can be swamped at prime time, which is why the player also remembers how channels behaved when you actually watched.

---

## For the curious (and the tinkerers)

### What's in the box

| File | What's in it |
|---|---|
| `index.html` | The screen and its dialogs |
| `app.js` | The engine: storage, playlists, parsing, the stream tester, playback (hls.js / mpegts.js / native, with Safari's own player for AirPlay), the TV picture, sleep timer, presets, share links, backup, keyboard |
| `modern.js` | The screen's brain: now playing, presets, recently watched, the channel picker, menu, and the layouts for rails and folds |
| `modern.css` | The look, plus the retro TV effects |
| `sw.js` | Offline shell |
| `manifest.webmanifest`, `icon-*.png` | Installable app |
| `lists/free-tv.m3u8` | This site's copy of Free-TV, refreshed daily by `.github/workflows/free-tv.yml` |
| `mirror/mirror.js` | The Cloudflare Worker that mirrors iptv-org for blocked networks (deployed separately, at video-mirror.jamal-akuna-matata.workers.dev) |
| `docs/` | Design decisions, implementation and testing notes, conversation record |
| `CLAUDE.md` | Notes for Claude Code when it works on this repo |

No frameworks, no bundler, no `package.json`. To run it locally, serve the folder:

```bash
python3 -m http.server 8000
```

### How it got here
This site was shaped in conversation, one request at a time. If you like a good backstory:

- **[Design decisions](docs/design/DECISIONS.md)**: what was decided and why, from "can I watch this on my Apple TV?" to language flags and folding phones, with a one-screen summary of how it all works today.
- **[Implementation and testing notes](docs/design/IMPLEMENTATION-NOTES.md)**: how the pieces fit, how notches and hinges were emulated for testing, and what still needs a real device.
- **[Conversation record](docs/conversations/2026-11-02_to_2026-11-12.md)**: the requests behind each change, in order.
- Miss the wood-panel TV? The design before the 2026-11-09 redesign lives on the branch `backup/pre-redesign-2026-11-09`.

### Host your own copy
1. Create a repository on GitHub, for example `m3u-player`.
2. Upload `index.html`, `modern.css`, `app.js`, `modern.js`, `sw.js`, `manifest.webmanifest`, the icons, the `lists/` folder and `.nojekyll`. `sample.m3u` is optional.
3. In **Settings → Pages**, choose **Deploy from a branch**, pick `main` and `/ (root)`, and save.
4. A minute later it's live at `https://<your-username>.github.io/m3u-player/`.

Now grab the remote. 📡

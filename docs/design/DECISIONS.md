# video.sala.company: design decisions

**Updated:** 2026-11-12 (summary added)
**Live:** https://video.sala.company (GitHub Pages, deployed from `main`)
**Pre-redesign rollback:** branch `backup/pre-redesign-2026-11-09` at `6a6b585` (the wood-cabinet TV and cable guide). Don't overwrite it.
**Related:** [implementation and testing notes](IMPLEMENTATION-NOTES.md) · [conversation record](../conversations/2026-11-02_to_2026-11-12.md) · the radio this design follows: [jamalxcode/radio](https://github.com/jamalxcode/radio) and its `docs/design/DECISIONS-2026-11-09.md`

This file records what the owner decided and why, newest decisions folded in. The code on `main` is the source of truth for what shipped; update this file with each new decision.

## The site today, at a glance
- **Channels:** iptv-org + Free-TV combined by default (about 12,400 channels, duplicates merged into backup sources); your own playlists by URL, file or pasted text. Free-TV loads from this site's copy (§2, §3).
- **Screen:** radio.sala.company's navy design with the retro TV picture kept (§4). Now playing: picture, channel, Play/Pause, real connection status with Retry, sleep selector, ◀ CH / CH ▶, details (sources, rating, Test, Copy link). 18 presets (no favorites, §5), Recently watched.
- **Picker:** Collections → Languages → Countries → Genres → Channels, all A–Z (§6, §7). Languages each on their own row with the flag of the country they started in; small countries and genres merged into groups of 6+. Countries are where a channel is registered, not its language. Silver ✓ for channels a test or play showed working. Picking a channel plays it and returns to the TV; sideways swipes move through the columns on phones and folds (§10).
- **Apple TV:** AirPlay from Safari, the Apple TV fetching the stream itself (§1).
- **Devices:** safe areas on all four sides, a side rail on landscape phones and narrow outer displays, one pane per screen on folding screens with nothing under the hinge, playback never interrupted by folding or rotating, dialogs above the keyboard, 44 px touch targets, installable (§9).
- **Data:** everything stays in the browser (IndexedDB); backup export / import and share links for presets and playlists.

## 1. Watching on Apple TV (2026-11-02)
- The owner has no Apple developer account and wanted the easiest way to watch on an Apple TV. A native tvOS app was ruled out: a free Apple ID install expires every 7 days, needs a Mac, and tvOS has no web view to wrap the site.
- **Decision: AirPlay from Safari.** hls.js plays video through Media Source Extensions, which AirPlay can't hand off. On browsers with Safari's AirPlay API (`WebKitPlaybackTargetAvailabilityEvent`), HLS channels now use Safari's own player, so the AirPlay button sends the stream itself to the Apple TV (the phone can be locked). Other browsers keep hls.js. `x-webkit-airplay="allow"` is on the `<video>`.
- Raw MPEG-TS / FLV channels (mpegts.js) still can't be AirPlayed; Screen Mirroring covers them.
- Owner confirmed it works on their Apple TV.

## 2. More channels (2026-11-05)
- The owner asked for more public channel lists from GitHub and elsewhere.
- **Decision: add Free-TV** ([Free-TV/IPTV](https://github.com/Free-TV/IPTV)), a curated list of channels that are free to watch, combined with iptv-org into the automatic default list ("All channels (iptv-org + Free-TV)", about 12,400 channels at the time). A channel in both becomes one channel with backup sources.
- A playlist URL can hold several lists separated by spaces; they're fetched together and merged.
- Free-TV groups by country name; those groups become the channel's country instead of cluttering Genres. YouTube page links (not streams) are skipped.
- Existing users' iptv-org-only default list is upgraded automatically.
- **Not added:** i.mjh.nz (Pluto / Samsung TV Plus / Plex / Roku) couldn't be verified from the build environment; random GitHub lists were avoided because many carry pirated channels.

## 3. Free-TV served from this site (2026-11-05)
- The owner's network blocks or stalls raw.githubusercontent.com, and jsDelivr refuses Free-TV because its repo is over jsDelivr's 50 MB limit, so the Free-TV quick add failed with "not found".
- **Decision:** keep a copy at `lists/free-tv.m3u8`, tried first (same site as the player, so it loads wherever the player does), with GitHub and githack as fallbacks. The *Refresh Free-TV copy* GitHub Action (`.github/workflows/free-tv.yml`) updates it daily and only accepts a download that looks like the real list. The service worker never caches `lists/`.

## 4. New screen modelled on radio.sala.company (2026-11-09)
The owner asked for the radio's new layout and station picker, **keeping the video screen**.
- **Kept from the TV:** the picture itself: test card when idle, static between channels, the green on-screen channel number, the cable-guide style messages (No signal, Still loading…) with their buttons, scanlines (switchable in Settings).
- **Taken from the radio:** navy brushed-metal panels; a menu (sidebar on wide screens, ☰ drawer on phones); a **Channels** button (TV icon) with the red Knight Rider scanner light; a Finder-style picker; a connection panel that reports the real player state; one sleep selector with a live countdown and **Sleep Off**; 18 presets (long-press 650 ms or Shift+Enter saves, one highlighted slot); Recently watched.
- **Picking a channel plays it and closes the picker** (returns to the TV), as on the radio. A large **← Back to TV** button closes it without picking.
- **Video-specific choices:** ◀ CH / CH ▶ buttons stay (channel changing matters more on a TV than on the radio); a *Channel details, sources and rating* section keeps source choice, ratings, Test and Copy link; volume slider hidden on touch screens (§9).
- **Removed with the redesign:** the wood cabinet and dial, the amber VCR info panel (source, type and resolution moved to the connection line), the old guide's sort / "working only" filters. Search matches names, languages, countries and genres.
- The old design is kept on `backup/pre-redesign-2026-11-09`.

## 5. Presets only, no favorites (2026-11-09)
- **Decision:** favorites removed (☆ button, menu item, picker collection, F key). Favorites were moved once into empty preset slots; favorites in old backups and old share links go into empty slots too, and whatever doesn't fit is added as a playlist. Saved favorites are left in browser storage, unused, rather than deleted.
- Settings → Share favorites became **Share presets** (fills the receiver's empty preset slots).
- Presets are saved copies; when a playlist loads they pick up their channel's latest stream links.

## 6. Picker sorting and countries (2026-11-09)
- The owner saw channels that seemed misplaced (4Kurd under France, High Vision TV and MBC America under United States). Checked: filtering and A–Z sorting are correct across all 905 country / genre combinations. **The country is where iptv-org registers a channel**, not its language (4Kurd is run from France; High Vision TV and MBC America from Los Angeles). Kept as is; the owner agreed.
- To make this readable, each channel row shows its language code (ENG, FAS, KOR…).
- Fixed: 4-digit counts no longer break across two lines.

## 7. Languages column (2026-11-09 / 10)
- **Decision:** a **Languages** column right after Collections: Collections → Languages → Countries → Genres → Channels. Picking a language narrows countries and genres. A channel with several languages is under each; ones with none are under **Unknown** (last).
- **Every language stands on its own row** (owner: no grouping for languages). Countries and genres still merge entries with only 1–2 channels into groups of 6+; a merged row counts each channel once.
- **Each language shows the flag of the country it started in** (owner's rule, e.g. English → 🇬🇧). Choices worth noting: Urdu → 🇵🇰 (national language, though it developed in what's now India), Latin → 🇮🇹, Cantonese → 🇨🇳. Kurdish, Romani, Tibetan, Uyghur and Serbo-Croatian have no country of their own and show no flag.
- Languages listed under two codes are one language: older bibliographic codes (`dut`/`nld`, `fre`/`fra`, `cze`/`ces`, `arm`/`hye`…) and two slips in iptv-org's data (`jap` on anime channels = Japanese, `far` on an Iranian channel = Persian).

## 8. Clean-up and review (2026-11-09)
- The owner asked for a review for missed bugs, then for the hidden old controls to be cleaned up. The hidden old controls (guide list, filters, cursor navigation, VCR display, dial, sleep knob, playlist menu) and the code behind them were removed (about 410 lines). `style.css` was replaced by `modern.css`.
- Review fixes: the connection panel updates the instant the player changes state; Recently watched redraws when its order changes; lock-screen / Control Center controls (Media Session: name, logo, play/pause, next/previous).

## 9. iPhone Duo and every other device (2026-11-11)
The owner set ten requirements: iPhone Duo folded and unfolded plus phones, tablets, foldables and desktops; automatic adaptation to sizes, orientations and fold transitions; the Duo's vertical Dynamic Island, side-mounted system UI and asymmetric safe areas; side navigation and vertical toolbars on the outer display; controls clear of gestures, edges and the fold; state and playback kept through folding and rotation; dialogs and keyboards fully visible; touch, mouse, keyboard and accessibility; Safari, Chrome, Android and installed apps; the same features everywhere.
- **Safe areas on every side.** The whole screen sits inside `env(safe-area-inset-*)` top, right, bottom and left independently, so a camera cutout or island on any edge, a side-mounted system bar or the home indicator never covers a control. The background still fills the display.
- **Side rail on short, wide screens** (landscape phones and a narrow outer display, `landscape` and height ≤ 560 px): the menu becomes a vertical toolbar (Home, Recently watched, Channels, Add playlist, Settings), the top bar goes away, the TV picture fills the height with the channel details beside it, and the picker slides in next to the rail.
- **Folding screens:** when the browser reports two screen segments (`window.viewport.segments`), each pane gets its own screen and nothing is placed under the hinge. Side by side: TV and controls on the first screen, the channel picker always open on the second. Top and bottom (half-folded): TV on top, picker below. The menu opens as a drawer on the first screen. Folding back returns the picker to how you left it.
- **Nothing reloads or moves on a fold, rotation or resize:** layouts are CSS only, so the channel keeps playing. The picker (collection, language, country, genre, search, scroll), the details section and the page scroll are also saved for the session, so they come back if the phone reloads the tab.
- **Dialogs and the keyboard:** dialogs are centred inside the safe area, scroll inside when tall, keep their buttons visible, and move above the on-screen keyboard (measured with `visualViewport`, since iOS doesn't shrink the page for it). Toasts too.
- **Touch:** on touch screens every control is at least 44 px; text fields use 16 px text so iOS doesn't zoom in; no double-tap zoom delay; the volume slider is hidden (the device's buttons work). Mouse and keyboard work as before; focus outlines, `inert` behind overlays, `aria-live` toasts, reduced motion.
- **Installable app:** web app manifest with icons (including a maskable one), standalone display, iOS home-screen meta (full screen, translucent status bar the layout keeps clear of), `interactive-widget=resizes-content` so Android shrinks the page for the keyboard.
- **The iPhone Duo itself** isn't something any browser here can emulate exactly; it was modelled from the owner's description (vertical island on the side, side system UI, a hinge when unfolded). If Safari on the Duo reports its hinge the way Chrome does (screen segments), the two-screen layout applies; if it doesn't, the unfolded Duo gets the normal wide layout, still inside the safe areas.

## 10. Channel picker reachable on phones and folds (2026-11-11)
- On radio the owner found (on a Galaxy Fold) that the station picker couldn't be swiped sideways to the stations, and a refresh during the slide after a tap stopped it short. Video had the same code and was checked: it had both problems.
- **Decision (same as radio):** the five columns are wider than a phone, so a sideways swipe that starts anywhere on them, including on a column's list, must move the row (columns contain only up/down scrolling). Choosing a collection, language, country or genre slides to the next columns and finishes even if the picker redraws meanwhile. On screens up to 1049 px wide the Channels column fills the space beside Genres (228–380 px), so after choosing a country you see Genres, full channel names and the ✓ / × marks together.
- Radio's fix was confirmed by the owner on the Fold; video's was verified in the browser at 390, 476 and 700 px, not yet on the Fold.

## Open items / not verified
- Not yet tried on a real iPhone, iPhone Duo, Fold or Apple TV after the redesign; the device work was tested with emulated safe areas and hinges (the AirPlay change itself was confirmed by the owner before it).
- Video's picker swipe fix (§10) hasn't been confirmed on the Fold yet (radio's has).
- Language flag choices the owner may want changed: Urdu → 🇵🇰, Latin → 🇮🇹, Cantonese → 🇨🇳 (§7).
- Possible later: i.mjh.nz FAST lists (Pluto, Samsung TV Plus) if they can be verified to work in a browser.

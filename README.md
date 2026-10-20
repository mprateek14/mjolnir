# Mjolnir

A download manager for Windows, built with Electron. It downloads files over several connections at once, pauses and resumes them, and keeps YouTube and screener.in downloads in their own tabs so one breaking never takes the rest down.

## What it does

**Main downloader**
- Splits a file into segments and downloads them in parallel, then re-splits as connections finish so none sit idle.
- Pause and resume, even after a restart. Resuming checks that the file on the server did not change.
- Queue with a limit on how many run at once, automatic retries, a speed limit for everything or for one download, and a scheduler.
- HLS (`.m3u8`) and DASH (`.mpd`) streams, including encrypted HLS and separate audio tracks. Chunks download in parallel and are joined with FFmpeg.
- Tells you when a newer version is published on GitHub, with a link to download it. You can turn the check off in Settings.
- A list you can sort by name, size, status or date, and columns you can resize. The date is the last time Mjolnir tried the download, whatever happened.

**YouTube downloader** (separate tab, uses [yt-dlp](https://github.com/yt-dlp/yt-dlp))
- Lists every quality the video offers, 4K and above included, with the real size for MP4 or MKV.
- Video or audio only, thumbnail and metadata embedding, subtitles.
- Playlists with a checklist, so you pick the videos you want.
- yt-dlp is downloaded on first use, checked against its published SHA-256, and can be updated from the page.

**Screener downloader** (separate tab)
- Give it a ticker or a screener.in company link. It downloads the annual reports, credit ratings and concall documents into `Screener\<TICKER>\<kind of document>`.

**Batch download**
- Paste many links, tickers or YouTube videos, one per line, in Normal, Screener or YouTube mode.
- Optionally put the batch in a new folder. An empty name becomes `Mjolnir_Batch_<date>`, with `_2`, `_3` and so on when that name is taken.

**Tools**
- Audio extractor: pulls the audio out of a video without re-encoding. It copies the stream, so the format stays whatever it was in the video.
- Clipboard: remembers the last 25 things you copied, text and pictures (GIFs included), and puts any of them back with a click. Items over 10 MB are skipped, and copies from password managers are never kept.

**Phone link**
- Turn it on, scan a QR code, and send links from your phone over Wi-Fi. YouTube and screener.in links go to their own tabs and show progress there.

**Browser extension** (Chrome and Edge)
- Takes over downloads the browser starts and opens a small confirmation window, so you never leave the browser.
- The toolbar icon opens a small panel. "Download from this page" works on a YouTube video, a screener.in company page or a page that loaded a video stream, and opens that downloader's window.
- The right-click menu item "Download with Mjolnir" works on links, images, video and audio.
- Turn takeover off, or set a minimum file size, from the extension dialog in the app.

## Requirements

- Windows 10 or later, 64-bit. The installers are Windows only.
- To run from source: [Node.js](https://nodejs.org) and npm.

## Run from source

```
npm install
npm start
```

## Tests

```
npm test            # offline: engine, HLS, DASH, Screener, YouTube, phone link, audio extractor
npm run test:live   # needs internet: checks the real yt-dlp download
```

## Build the installers

```
npm run dist
```

This writes `Mjolnir-Setup-<version>.exe` and `Mjolnir-Portable-<version>.exe` to `dist/`. They are not code signed, so Windows SmartScreen will warn on first run. Choose More info, then Run anyway.

## Set up the browser extension

1. Get the extension folder. Download `Mjolnir-Extension-<version>.zip` from the [latest release](https://github.com/mprateek14/mjolnir/releases/latest) and unzip it. It is also the `extension` folder in this repo.
2. Open `chrome://extensions` (or `edge://extensions`) and turn on Developer mode.
3. Choose Load unpacked and pick the unzipped folder.
4. Click the Mjolnir icon in your browser's toolbar. It says Connected when Mjolnir is running. There is nothing to copy or paste.

The extension talks only to `127.0.0.1:24680`. The browser stamps every request with the extension's ID, which a web page cannot fake, and Mjolnir refuses anything that does not carry it. So web pages cannot queue downloads on their own. The extension has a fixed ID, set by the `key` in its manifest.

## Phone link

Click the phone icon, switch it on and scan the code with your phone camera. The first time, Windows asks to allow Mjolnir on private networks. Choose Allow. The link listens on port 24681 or the next free one, and only paired phones can send links.

## Where things are saved

- Settings, the download list, paired phones and yt-dlp live in `%APPDATA%\Mjolnir`.
- Downloads go to `Downloads\Mjolnir` by default, with `YouTube` and `Screener` folders inside it. If an older `Downloads\SwiftGet` or `Downloads\IceFox Downloader` folder exists, that one is used instead.

## Project layout

```
src/
  main.js              app start, window, the extension bridge, batch
  preload.js           what the main window may call
  ui/                  main window (list, dialogs, columns)
  capture/             the small "File info" window for browser downloads
  engine/              HTTP, HLS and DASH download engine and queue
  downloaders/         YouTube and Screener, each isolated (see its README)
  tools/               tools that work on local files (audio extractor)
  phonelink/           the phone link server and its page
extension/             Chrome and Edge extension
test/                  tests and fixtures
```

Each downloader runs in its own page and process, keeps its own data, and touches its external tool in exactly one file. Adding another one is described in [src/downloaders/README.md](src/downloaders/README.md).

## Limits

- Live streams are not recorded. DRM protected streams cannot be downloaded.
- Some YouTube videos need a signed-in session. Choose your browser under Sign-in cookies in the YouTube settings.
- YouTube Premium login and clips by time range are planned and not built yet.

## Use it responsibly

Download only what you have the right to download, and follow the terms of the sites you use.

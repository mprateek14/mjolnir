# Downloaders

Each dedicated downloader (YouTube today, more later) is a folder here. The main download flow in `src/engine` knows nothing about them, and they know nothing about it.

## How isolation works

- **Own page.** A downloader's UI is a separate page in its own renderer process (`WebContentsView`). If it crashes, the main window keeps running.
- **Own logic.** Its code runs through `host.js`, which catches every error from a handler and returns it to that page. Nothing it throws reaches the main process.
- **Own data.** State lives in `<userData>/downloaders/<id>/`.
- **Own tool.** External programs (yt-dlp for YouTube) are touched in exactly one file. When the tool changes, that file is the fix.

## Adding a downloader

1. Make `src/downloaders/<id>/` with `index.js`, `ui/index.html`, `ui/app.js`.
2. `index.js` exports `{ id, name, description, create(ctx) }`. `create` returns `{ handlers, dispose }`.
3. Add `'./<id>'` to `registry.js`. It then appears in the sidebar under Downloaders.

`ctx` gives you `dataDir`, `emit(channel, payload)` (to your page), `notify(title, body)`, `shell`, `pickFolder()`, `ffmpeg` (path to the bundled ffmpeg), `jsRuntime` (Electron's Node, for tools that need one) and `settings()` (the main app's settings, read only).

The page calls `await dl.invoke('handlerName', ...args)` and listens with `dl.on('channel', fn)`. Those two functions are all it gets.

## YouTube

- `youtube/ytdlp.js` is the only file that knows yt-dlp's flags and output format. It downloads the official build, checks the published SHA-256, and swaps it in only if the new binary starts.
- `youtube/index.js` holds the job queue and talks to the page.
- If YouTube changes and downloads start failing, the Update button in the page fetches a newer yt-dlp. No app update is needed for that.
- Test it with `npm run test:live` (needs internet).

## Links that arrive from outside the page

A paired phone (`src/phonelink`) can send links while no downloader page is open. To claim some, a module exports `matches(url)` and offers two handlers:

- `quickAdd(url)` adds the link using the module's saved defaults and returns `{ id, title }`. It throws a readable message when it cannot (the phone shows it).
- `peek(id)` returns `{ status, percent, title, size }` so the phone can show progress.

Anything no module claims goes to the main downloader.

## Tool modules

A module does not have to download anything. Set `kind: 'tool'` and `dir: __dirname` in its definition and add it to `registry.js`. Tool modules live in `src/tools/` instead (the audio extractor is the first) and show under Tools in the sidebar. They work on files already on the PC. They follow the same contract (`create(ctx)`, a page, handlers) and use `ctx.pickFiles()` to choose files and `dl.pathOf(file)` in the page to read the path of a file dropped onto it. FFmpeg and ffprobe come from `ctx.ffmpeg` and `ctx.ffprobe`.

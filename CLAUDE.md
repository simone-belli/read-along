# Read Along

A web page that reads Markdown aloud while highlighting the words being spoken, so the reader can read and listen at the same time. Owner: Simone Belli. MIT licensed.

Live site: https://simone-belli.github.io/read-along/ (GitHub Pages, deployed from `main`, root folder).

## Files

- `index.html`: the app page: toolbar, Markdown rendering, loading files. No build step, no server.
- `engine.js`: the reading engine (model, highlighting, both voice engines, transport, settings). Plain script, exposes `ReadAlong.create()`. Also used, as a pinned copy, by the Notes site (`simone-belli/notes`, `docs/assets/read-along/engine.js`).
- `tests/e2e.py`: end-to-end browser tests (Playwright, Python) with a simulated ElevenLabs API.
- `tests/embed.html`: fixture page that drives `engine.js` the way an embedding site does (Material/KaTeX-style markup).
- `tests/package.json`: local copies of the CDN libraries, so the tests can run offline.
- `README.md`, `LICENSE`, `logo.svg`: user-facing docs, MIT license, logo. `index.html` inlines the logo once as `<symbol id="logo-mark">` and reuses it with `<use>` (toolbar, welcome page, footer, drop overlay); the favicon is a separate data URI copy.

## Ground rules

- **Commit and push straight to `main`, for changes of any size, without asking first.** This is a standing agreement with the owner (October 2026). Open a pull request only when the owner asks for one. Pushing to `main` deploys the live site within a minute or two, so the tests must pass first (see below).
- **Keep it two plain files: `index.html` and `engine.js`.** No bundler, no framework, no backend. External libraries come only from CDNs, pinned to exact versions.
- **`engine.js` is a public interface.** Notes copies it; keep `ReadAlong.create()` options backwards compatible, and after changing it tell the owner the Notes copy needs refreshing.
- **Never put an API key in the repo.** The user's ElevenLabs key lives in their browser's localStorage and is entered through the settings panel.
- **Run `python3 tests/e2e.py` before every push** and keep it passing. Add checks for new behaviour.
- Keep the look close to Cursor/VS Code's dark Markdown preview, which the owner reads in every day.

## How the code is organised

The sections are numbered (search for `// N.`). `index.html` holds 1, 11 and 13; `engine.js` holds the rest inside `ReadAlong.create(options)`. The options (`blockSelector`, `skipSelector`, `mathSelector`, `displayMathSelector`, `tex`, `viewport`, `summary`, `reveal`, `keys`) are what let another site use the engine on its own markup; the `ui` option maps control names to elements.

1. **Rendering.** markdown-it plus highlight.js. Maths (`$…$`, `$$…$$`, `\(…\)`, `\[…\]`) is pulled out before Markdown parsing, so `_` and `*` survive. It is restored as `<span class="math" data-tex>` and typeset by MathJax.
2. **Speakable maths.** `speakMath()` turns TeX into rough spoken words ("x squared over 2 sigma squared"). Extend `TEX_WORDS` for new symbols.
3. **Model.** The rendered DOM is walked into:
   - **blocks**: paragraphs, headings, list items and table cells, each with the spoken text and a map back to DOM text nodes.
   - **chunks**: sentences, with `splitSentences()` handling abbreviations like "e.g.".

   Code blocks (`pre`) are not read. `markStops()` attaches the code block, display formula or table that precedes a chunk to that chunk's `stops`.
4. **Highlighting.** Uses the CSS Custom Highlight API with three highlights: `tts-read`, `tts-sentence` and `tts-word`. The DOM is never rewritten during playback. Browsers without the API fall back to tinting the current block. **Follow** keeps the spoken word in the upper part of the `viewport` band: past 60% of it, the page scrolls it back to 30%.
5. **Shared state.** `pos = {ci, off}` is the current sentence and character offset. Every async step checks the `gen` counter and drops out if it is stale.
6. **System voice engine.** Web Speech API, one utterance per sentence. Word timing comes from `onboundary`, which some voices never fire.
7. **ElevenLabs engine.**
   - Calls `POST /v1/text-to-speech/{voice}/with-timestamps` and gets audio plus per-character start times.
   - Generates one **segment** per paragraph (at most 1,200 characters), prefetches two ahead, and plays through one `<audio>` element.
   - `elTick` maps `audio.currentTime` to a character offset on every animation frame.
   - Audio is cached in IndexedDB (`read-along` database), keyed by a hash of model, voice and text, so replays cost no credits.
   - Speed uses `audio.playbackRate`, so changing speed never regenerates audio.
8. **Transport.** Play, pause, stop and seek work the same for both engines. `stopAt()` implements "Pause at blocks".
9. **Time display and scrubber.** Positions are measured in characters and converted to time with a calibrated characters-per-second rate.
10. **Settings.**
    - Engine, voice, model and speed controls, plus the API key flow. The key is checked with ElevenLabs before it is saved, then hidden.
    - localStorage keys are prefixed `readalong.`: `elKey`, `elVoice`, `elModel`, `engine`, `voice`, `rate`, `follow`, `pauseBlocks`, and `lastDoc` (set by `index.html`).
11. **Loading.** Open button, drag and drop, or paste. The last document is remembered (`readalong.lastDoc` in localStorage). In Chrome and Edge the Open button uses `showOpenFilePicker` and drops use `getAsFileHandle`, and the file handle is kept in a separate IndexedDB database, `read-along-files`, so ↻ can reread the file and say whether it changed. After a page reload Chrome wants a click before the file can be read again (unless the user chose "Allow on every visit"), so start-up then shows a notice with "Load the current version", and Play or Space check the file before reading. Elsewhere ↻ reopens the file picker. The logo shows the sample again.
    - **Links.** A click on a relative link to a `.md`/`.markdown`/`.mdown`/`.txt` file opens that file. The first one asks for the folder that holds the current file: in Chrome and Edge `showDirectoryPicker`, with the handle kept under `'folder'` in `read-along-files` and the file located in it with `resolve()`; elsewhere a `webkitdirectory` input, with the file found by name and text, kept until the page reloads. Back and Forward use `history.pushState`, and the documents shown live in `visited` until the page reloads. Links to websites open in a new tab. Other relative links (images, PDFs) only show a message.
12. **Interaction.** Space plays or pauses, ←/→ move by sentence, Esc stops, and double-clicking a sentence starts reading there.
12b. **Status line.** `index.html` passes `summary: false`, so the status line shows only messages (errors, "Paused at…", "Updated…") as a label under the toolbar and is hidden when empty. Notes keeps the default (`summary: true`): sentence count and ElevenLabs cost.
13. **Start-up.** The engine restores settings; `index.html` loads the last document (rereading it from disk when the browser still grants access), or the sample on a first visit.

## ElevenLabs notes

- Auth header: `xi-api-key`. Keys start with `sk_`. The key *ID* shown in the dashboard list is not a key.
- The key needs **Text to Speech** and **Voices: read**. **User: read** is optional and enables the credits display through `/v1/user/subscription`.
- Default model `eleven_flash_v2_5` (about ½ credit per character). `eleven_multilingual_v2` costs 1 credit per character. The free plan has about 10,000 credits a month.
- The live API can't be reached from Claude's cloud workspace. Test against the fake in `tests/e2e.py`, and ask the owner to try real playback when the API contract changes.

## Testing

```
pip install playwright && playwright install chromium   # once
cd tests && npm install && cd ..                          # once, optional (offline libraries)
python3 tests/e2e.py                                      # exits 0 when all checks pass
```

The fake ElevenLabs returns silent WAV audio at 30 characters per second, with exact timings. Checks cover:
- rendering
- word highlighting
- pause and resume
- seeking
- caching
- key handling
- pause at blocks
- Follow (scrolls along when ticked, stays put when not)
- remembering and reloading the last document (served over localhost, because file handles need a secure origin)
- following links to other Markdown files, with and without file handles, plus Back and Forward

## Known gaps and ideas

- Relative image paths in a loaded Markdown file still don't resolve. The folder handle that links use could now serve them as blob URLs.
- Ideas raised but not built: opening the current file straight from Cursor, PDF support.

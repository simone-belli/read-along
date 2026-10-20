<p align="center"><img src="logo.svg" width="96" alt="Read Along logo"></p>

# Read Along

Read Markdown while hearing it read aloud. The text is shown the way Cursor's Markdown preview shows it, LaTeX included, and the words are highlighted as they're spoken, so your eyes and ears follow the same line.

**Try it:** https://simone-belli.github.io/read-along/

## Features

- **Read-along highlighting.** Unread text is grey, spoken text turns bright, the current sentence is tinted and the current word is marked.
- **Proper rendering.** Headings, lists, tables, code with syntax colouring, and LaTeX via MathJax (`$…$` inline, `$$…$$` display).
- **Two voice engines.**
  - **ElevenLabs:** natural voices with exact per-word timing (needs your own API key).
  - **System voice:** the browser's built-in voices. Free and offline, but robotic.
- **Full playback control.** Play/pause, previous/next sentence, a scrubber with elapsed and total time, speed from 0.8× to 2×, and auto-scroll that follows the reading.
- **Pause at blocks.** Optionally stops before each code block, display formula or table so you can read it, then carries on when you press Play.
- **Easy loading.** Open a `.md` file, drag one onto the page, or paste Markdown anywhere.
- **Picks up where you left off.** The page reopens the last document you loaded. In Chrome and Edge the ↻ button rereads the file from disk and tells you whether it changed; choose "Allow on every visit" and the page loads the latest version by itself. Click the logo to see the welcome page again.

## Keyboard

| Key | Action |
|-----|--------|
| Space | Play / pause |
| ← / → | Previous / next sentence |
| Esc | Stop |
| Double-click a sentence | Start reading from there |

## Using ElevenLabs voices

1. Create an API key at [elevenlabs.io](https://elevenlabs.io) under **Developers → API Keys**. Give it these permissions:
   - **Text to Speech** (required)
   - **Voices: read** (required, to list your voices)
   - **User: read** (optional; lets the page show your remaining credits)
2. Copy the key itself. It starts with `sk_` and is shown only once, when the key is created. The key *ID* in the list won't work.
3. In Read Along, click the gear icon, then **Add key**, and paste it.

**Costs.** The free plan includes about 10,000 credits a month. The Flash model uses about ½ credit per character and Multilingual v2 uses 1. The page shows what a document will cost before you play it. Generated audio is cached in your browser, so replaying, pausing and skipping around cost nothing extra.

**Privacy.** Your key is stored only in your browser's local storage and is sent only to ElevenLabs. It is never part of this repository. The text you play is sent to ElevenLabs to be spoken.

## Running it locally

There's no build step: open `index.html` in Chrome, Edge or Safari (it loads `engine.js` from the same folder). It loads markdown-it, highlight.js and MathJax from public CDNs, so it needs an internet connection.

## Development

The page is `index.html`; the reading engine is `engine.js`, which other sites can reuse through `ReadAlong.create()`. Browser tests with a simulated ElevenLabs API are in `tests/`:

```
pip install playwright && playwright install chromium
python3 tests/e2e.py
```

`CLAUDE.md` describes how the page is built, for anyone (or any Claude session) working on it.

## Limitations

- Formulas are spoken in a simplified way, such as "x squared over 2 sigma squared". The rendering on screen is exact.
- With the system voice, word-level highlighting depends on the voice. Some only report timing per sentence.
- Relative image paths in a Markdown file won't load, because the page can't see the file's folder.

## License

[MIT](LICENSE) © 2026 Simone Belli

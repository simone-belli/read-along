// Read Along engine: reads an already-rendered page aloud and highlights the words being spoken.
//
// Used by Read Along's own index.html and, as a pinned copy, by other sites (e.g. the
// Notes site). It knows nothing about Markdown: give it a root element whose content is
// already rendered, plus the player controls, and it does the rest.
//
//   const ra = ReadAlong.create({ root, ui, ...options });   // see DEFAULTS below
//   ra.refresh();        // (re)build the model after the root's content changes
//
// `ui` maps names to elements. Required: play, prev, next, stop, scrub, time, status,
// rate, follow, pauseBlocks, engine, voice, model, gear, settings, keyRow, apikey,
// saveKey, cancelKey, changeKey, keyStatus, credits. Optional: pauseBlocks2 (a second
// "pause at blocks" box, kept in sync). Settings live in localStorage under `readalong.*`.
(() => {
  'use strict';

  const DEFAULTS = {
    // elements whose text forms one block (a paragraph, heading, list item, cell…)
    blockSelector: 'h1,h2,h3,h4,h5,h6,p,li,td,th,dt,dd,figcaption,summary',
    // subtrees that are never read
    skipSelector: 'pre, script, style',
    // formulas: read as one unit, spoken via speakMath(tex(el))
    mathSelector: '.math',
    displayMathSelector: '.math.display',
    tex: (el) => el.dataset.tex,
    // visible band for "Follow": the current word is kept between these y coordinates
    viewport: () => ({ top: 16, bottom: window.innerHeight - 60 }),
    // called before the reader moves into a new block (e.g. to open a collapsed section)
    reveal: null,
    // whether the shortcuts (Space, ←/→, Esc, double-click to jump) are live for this event
    keys: () => true
  };

  function create(options) {
    const opts = Object.assign({}, DEFAULTS, options);
    const root = opts.root, ui = opts.ui;
    const MATH_SEL = opts.mathSelector, DISPLAY_SEL = opts.displayMathSelector;
    const SKIP_SEL = opts.skipSelector;
    const synth = window.speechSynthesis;
    const HAS_HL = typeof CSS !== 'undefined' && 'highlights' in CSS && typeof Highlight !== 'undefined';
    if (!HAS_HL) document.body.classList.add('no-hl');

    const ICON_PLAY = '<svg viewBox="0 0 24 24"><path d="M7 5v14l12-7z"/></svg>';
    const ICON_PAUSE = '<svg viewBox="0 0 24 24"><path d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg>';

    const escapeHtml = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const fmt = (sec) => { sec = Math.max(0, sec || 0); return Math.floor(sec / 60) + ':' + String(Math.floor(sec % 60)).padStart(2, '0'); };
    const setStatus = (msg) => { ui.status.textContent = msg; };
    const store = {
      get(k) { try { return localStorage.getItem('readalong.' + k); } catch { return null; } },
      set(k, v) { try { localStorage.setItem('readalong.' + k, v); } catch { /* storage unavailable */ } }
    };

    // ======================================================================
    // 2. Turning maths into something speakable (simple, easy to extend)
    // ======================================================================
    const TEX_WORDS = {
      infty: 'infinity', int: 'integral of', sum: 'sum of', prod: 'product of',
      cdot: 'times', times: 'times', approx: 'approximately', sim: 'distributed as',
      propto: 'proportional to', leq: 'less than or equal to', le: 'less than or equal to',
      geq: 'greater than or equal to', ge: 'greater than or equal to', neq: 'not equal to', ne: 'not equal to',
      to: 'to', rightarrow: 'to', mapsto: 'maps to', ldots: 'dot dot dot', cdots: 'dot dot dot', dots: 'dot dot dot',
      pm: 'plus or minus', mid: 'given', lim: 'limit', ln: 'log', partial: 'partial',
      quad: '', qquad: '', langle: '', rangle: '', displaystyle: ''
    };

    function speakMath(tex) {
      let s = tex;
      for (let k = 0; k < 4; k++) {
        s = s.replace(/\\sqrt\s*\{([^{}]*)\}/g, ' square root of $1 ')
             .replace(/\\[dt]?frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, ' $1 over $2 ');
      }
      s = s.replace(/\\(?:mathrm|mathbf|mathit|mathcal|mathbb|mathsf|text|textrm|operatorname|boldsymbol|hat|bar|tilde)\s*\{([^{}]*)\}/g, ' $1 ')
           .replace(/\\(?:left|right|big|Big|bigg|Bigg)\b/g, ' ')
           .replace(/\\([A-Za-z]+)/g, (m, w) => ' ' + (w in TEX_WORDS ? TEX_WORDS[w] : w) + ' ')
           .replace(/\^\s*\{([^{}]*)\}|\^\s*(\S)/g, (m, a, b) => ' to the ' + (a ?? b) + ' ')
           .replace(/_\s*\{([^{}]*)\}|_\s*(\S)/g, (m, a, b) => ' sub ' + (a ?? b) + ' ')
           .replace(/=/g, ' equals ').replace(/\+/g, ' plus ').replace(/-/g, ' minus ')
           .replace(/</g, ' less than ').replace(/>/g, ' greater than ').replace(/\//g, ' over ')
           .replace(/[{}\\&()[\]|]/g, ' ')
           .replace(/\bto the 2\b/g, 'squared')
           .replace(/\s+/g, ' ').trim();
      return s;
    }

    // ======================================================================
    // 3. Model: blocks (paragraphs, list items, headings…) split into sentences,
    //    with a map from spoken-text offsets back to DOM positions.
    // ======================================================================
    const BLOCK_SEL = opts.blockSelector;
    let blocks = [];   // { el, segs: [{ node, math, start, end }], text }
    let chunks = [];   // { block, start, end, text, cum }  — one per sentence
    let mathEls = [];
    let totalChars = 0;

    function splitLong(text, s, e, max = 220) {
      if (e - s <= max) return [[s, e]];
      const out = [];
      let cur = s;
      while (e - cur > max) {
        const window_ = text.slice(cur, cur + max);
        let cut = -1;
        const re = /[,;:—–]\s/g;
        let m;
        while ((m = re.exec(window_))) cut = cur + m.index + 1;
        if (cut <= cur) {
          const sp = text.lastIndexOf(' ', cur + max);
          cut = sp > cur ? sp : cur + max;
        }
        out.push([cur, cut]);
        cur = cut;
      }
      out.push([cur, e]);
      return out;
    }

    function splitSentences(text) {
      const out = [];
      const re = /[.!?]+["'”’)\]]*(?=\s|$)/g;
      let start = 0, m;
      while ((m = re.exec(text))) {
        const end = m.index + m[0].length;
        // don't break after common abbreviations ("e.g.", "i.e.", "Dr.", "Fig.", …)
        if (/(?:^|[\s(])(?:e\.g|i\.e|etc|vs|cf|al|approx|Dr|Mr|Mrs|Ms|Prof|Fig|Eq|Sec|No|[A-Z])\.$/i.test(text.slice(Math.max(0, end - 8), end))
            && !/^\s*$/.test(text.slice(end))) continue;
        out.push([start, end]);
        start = end;
      }
      if (start < text.length) out.push([start, text.length]);
      return out.flatMap(([s, e]) => splitLong(text, s, e));
    }

    function buildModel() {
      blocks = []; chunks = []; mathEls = [...root.querySelectorAll(MATH_SEL)];
      const byEl = new Map();
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
        acceptNode(n) {
          if (n.nodeType === 1) {
            if (n.matches(MATH_SEL)) return NodeFilter.FILTER_ACCEPT;
            if (n.matches(SKIP_SEL)) return NodeFilter.FILTER_REJECT;   // code blocks (and anything else skipped) are not read
            return NodeFilter.FILTER_SKIP;
          }
          return n.parentElement.closest(MATH_SEL) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
        }
      });

      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const host = (n.nodeType === 1 ? n : n.parentElement).closest(BLOCK_SEL);
        if (!host || !root.contains(host)) continue;
        let b = byEl.get(host);
        if (!b) { b = { el: host, segs: [], text: '' }; byEl.set(host, b); blocks.push(b); }

        if (n.nodeType === 1) {                       // a formula: one atomic unit
          const spoken = ' ' + speakMath(opts.tex(n) || '') + ' ';
          b.segs.push({ node: n, math: true, start: b.text.length, end: b.text.length + spoken.length });
          b.text += spoken;
        } else {
          if (n.previousSibling && n.previousSibling.nodeName === 'BR' && !/\s$/.test(b.text)) b.text += ' ';
          const t = n.nodeValue;
          b.segs.push({ node: n, math: false, start: b.text.length, end: b.text.length + t.length });
          b.text += t;
        }
      }

      let cum = 0;
      for (const b of blocks) {
        for (const [s, e] of splitSentences(b.text)) {
          const raw = b.text.slice(s, e);
          if (!/[\p{L}\p{N}]/u.test(raw)) continue;
          const start = s + (raw.length - raw.trimStart().length);
          const end = e - (raw.length - raw.trimEnd().length);
          chunks.push({ block: b, start, end, text: b.text.slice(start, end), cum });
          cum += end - start;
        }
      }
      totalChars = cum;
      markStops();
    }

    // Stop points for "Pause at blocks": each code block, table or display formula is attached
    // to the first sentence after it (that sentence's `stops`). Sentences inside a table or a
    // display formula get `inBlock`; while pausing at blocks they are skipped, not read.
    let preEls = [];
    function markStops() {
      preEls = [...root.querySelectorAll('pre')];
      for (const c of chunks) { c.stops = null; c.inBlock = null; }
      const add = (c, el) => { if (c) (c.stops || (c.stops = [])).push(el); };
      const follows = (el) => (c) => {
        const r = el.compareDocumentPosition(c.block.el);
        return (r & Node.DOCUMENT_POSITION_FOLLOWING) && !(r & Node.DOCUMENT_POSITION_CONTAINS);
      };
      for (const el of root.querySelectorAll('pre, table, ' + DISPLAY_SEL)) {
        let inside = () => false, fallback = follows(el);
        if (el.matches(DISPLAY_SEL)) {
          const host = el.closest(BLOCK_SEL);
          const b = blocks.find((x) => x.el === host);
          const seg = b && b.segs.find((s) => s.node === el);
          if (!seg) continue;
          inside = (c) => c.block === b && c.start >= seg.start && c.end <= seg.end;
          fallback = (c) => c.block === b && c.end > seg.start;   // a formula inside a sentence: stop at that sentence
        } else if (el.matches('table')) {
          inside = (c) => el.contains(c.block.el);
        }
        let last = -1;
        chunks.forEach((c, i) => { if (inside(c)) { c.inBlock = c.inBlock || el; last = i; } });
        add(last >= 0 ? chunks[last + 1] : chunks.find(fallback), el);
      }
    }
    const BLOCK_NAMES = (els) => {
      const kinds = new Set(els.map((e) => e.matches('pre') ? 'a code block' : e.matches('table') ? 'a table' : 'a formula'));
      return [...kinds].join(' and ');
    };

    // spoken offset within a block -> DOM point
    function domPoint(block, off, preferEnd) {
      const segs = block.segs;
      let i = 0;
      for (let k = 0; k < segs.length; k++) { if (segs[k].start <= off) i = k; else break; }
      if (preferEnd && i > 0 && off === segs[i].start) i -= 1;
      const seg = segs[i];
      if (seg.math) return { el: seg.node, after: preferEnd || off >= seg.end };
      return { node: seg.node, offset: Math.max(0, Math.min(off - seg.start, seg.node.nodeValue.length)) };
    }

    function setBoundary(range, which, block, off, preferEnd) {
      const p = domPoint(block, off, preferEnd);
      const end = which === 'end';
      if (p.el) {
        if (p.after) end ? range.setEndAfter(p.el) : range.setStartAfter(p.el);
        else end ? range.setEndBefore(p.el) : range.setStartBefore(p.el);
      } else {
        end ? range.setEnd(p.node, p.offset) : range.setStart(p.node, p.offset);
      }
    }

    function makeRange(block, s, e) {
      const r = document.createRange();
      setBoundary(r, 'start', block, s, false);
      setBoundary(r, 'end', block, e, true);
      return r;
    }

    // ======================================================================
    // 4. Painting the read-along highlight
    // ======================================================================
    const hl = HAS_HL ? { read: new Highlight(), sentence: new Highlight(), word: new Highlight() } : null;
    if (hl) {
      hl.read.priority = 0; hl.sentence.priority = 1; hl.word.priority = 2;
      CSS.highlights.set('tts-read', hl.read);
      CSS.highlights.set('tts-sentence', hl.sentence);
      CSS.highlights.set('tts-word', hl.word);
    }
    let currentBlockEl = null;

    function paint(ci, progress, word) {
      const c = chunks[ci];
      if (!c) return;
      const b = c.block;
      if (opts.reveal && b.el !== currentBlockEl) opts.reveal(b.el);   // e.g. open a collapsed section first
      root.classList.add('active');

      const sentence = makeRange(b, c.start, c.end);
      const wordRange = word ? makeRange(b, word[0], word[1]) : null;
      const read = document.createRange();
      read.setStart(root, 0);
      setBoundary(read, 'end', b, progress, true);

      if (hl) {
        hl.read.clear();
        for (const r of skipPre(read)) hl.read.add(r);
        hl.sentence.clear(); hl.sentence.add(sentence);
        hl.word.clear(); if (wordRange) hl.word.add(wordRange);
      }
      for (const pe of preEls) pe.classList.toggle('read', read.intersectsNode(pe));
      for (const m of mathEls) {
        m.classList.toggle('read', read.intersectsNode(m));
        m.classList.toggle('now', !!wordRange && wordRange.intersectsNode(m));
      }
      if (currentBlockEl !== b.el) {
        if (currentBlockEl) currentBlockEl.removeAttribute('data-ra-current');
        currentBlockEl = b.el;
        if (!HAS_HL) currentBlockEl.setAttribute('data-ra-current', '');
      }
      follow(wordRange || sentence);
    }

    // The "read" highlight recolours text, which would wipe out the syntax colours of a code
    // block it covers, so it is split into pieces that go around every code block.
    function skipPre(range) {
      const pieces = [];
      let rest = range.cloneRange();
      for (const pe of preEls) {
        if (!rest.intersectsNode(pe)) continue;
        const piece = rest.cloneRange();
        piece.setEndBefore(pe);
        pieces.push(piece);
        rest.setStartAfter(pe);
      }
      pieces.push(rest);
      return pieces;
    }

    function clearPaint() {
      if (hl) { hl.read.clear(); hl.sentence.clear(); hl.word.clear(); }
      for (const m of mathEls) m.classList.remove('read', 'now');
      for (const pe of preEls) pe.classList.remove('read');
      if (currentBlockEl) currentBlockEl.removeAttribute('data-ra-current');
      currentBlockEl = null;
      root.classList.remove('active');
    }

    function follow(range) {
      if (!ui.follow.checked || !range) return;
      const r = range.getBoundingClientRect();
      if (!r.width && !r.height) return;
      const { top, bottom } = opts.viewport();
      if (r.top < top || r.bottom > bottom) {
        window.scrollBy({ top: r.top - (top + (bottom - top) * 0.35), behavior: 'smooth' });
      }
    }

    // ======================================================================
    // 5. Shared playback state
    // ======================================================================
    let pos = { ci: 0, off: 0 };         // where we are: sentence index + char offset inside it
    let playing = false, gen = 0;
    const baseCps = { system: 14, eleven: 15 };   // chars/second at 1x, refined while listening

    const engine = () => ui.engine.value;
    const rate = () => parseFloat(ui.rate.value) || 1;
    const cps = () => baseCps[engine()] * rate();

    function calibrate(eng, chars, seconds1x) {
      if (seconds1x < 0.4 || chars < 10) return;
      const measured = chars / seconds1x;
      if (measured > 4 && measured < 40) baseCps[eng] = 0.75 * baseCps[eng] + 0.25 * measured;
    }

    // ======================================================================
    // 6. Engine A: the browser's built-in voices (free, offline, robotic)
    // ======================================================================
    let speakOff = 0, utterStart = 0, sawBoundary = false, warnedNoBoundary = false;
    let currentUtter = null;             // keep a reference (Chrome can GC utterances mid-speech)

    const systemVoice = () => (synth ? synth.getVoices().find((v) => v.voiceURI === ui.voice.value) : null) || null;

    function speakFrom(ci, off = 0) {
      const myGen = ++gen;
      const r = readable(ci);
      if (r !== ci) { ci = r; off = 0; }
      if (ci >= chunks.length) { finish(); return; }
      pos = { ci, off };
      const c = chunks[ci];
      const text = c.text.slice(off);
      speakOff = off; sawBoundary = false; utterStart = 0;
      paint(ci, c.start + off, null);

      const u = new SpeechSynthesisUtterance(text);
      const v = systemVoice();
      if (v) { u.voice = v; u.lang = v.lang; }
      u.rate = rate();

      u.onstart = () => { if (myGen === gen) utterStart = performance.now(); };
      u.onboundary = (e) => {
        if (myGen !== gen || (e.name && e.name !== 'word')) return;
        sawBoundary = true;
        const s = Math.min(off + e.charIndex, c.text.length);
        const len = e.charLength > 0 ? e.charLength : ((/^\S+/.exec(c.text.slice(s)) || [''])[0].length || 1);
        const end = Math.min(s + len, c.text.length);
        pos.off = s;
        paint(ci, c.start + end, [c.start + s, c.start + end]);
      };
      u.onend = () => {
        if (myGen !== gen) return;
        if (utterStart) calibrate('system', text.length, (performance.now() - utterStart) / 1000 * rate());
        if (!sawBoundary && text.length > 40 && !warnedNoBoundary) {
          warnedNoBoundary = true;
          setStatus('This voice does not report word timing, so tracking is per sentence.');
        }
        const next = readable(ci + 1);
        if (shouldStopAt(next)) stopAt(next); else speakFrom(next, 0);
      };
      u.onerror = (e) => {
        if (myGen !== gen || e.error === 'interrupted' || e.error === 'canceled') return;
        setStatus('Speech error: ' + e.error);
        pause();
      };

      currentUtter = u;
      const go = () => { if (myGen !== gen) return; if (synth.paused) synth.resume(); synth.speak(u); };
      if (synth.speaking || synth.pending) { synth.cancel(); setTimeout(go, 60); } else go();
    }

    // ======================================================================
    // 7. Engine B: ElevenLabs (natural voices, exact per-character timing)
    //    Audio is generated one paragraph at a time, two paragraphs ahead,
    //    and cached in the browser so re-listening costs no credits.
    // ======================================================================
    const EL_API = 'https://api.elevenlabs.io/v1';
    const EL_COST = { eleven_flash_v2_5: 0.5, eleven_multilingual_v2: 1 };   // credits per character
    const EL_FALLBACK_VOICES = [               // used only if the voice list can't be fetched
      { id: 'EXAVITQu4vr4xnSDxMKL', name: 'Sarah', desc: 'American, female' },
      { id: 'JBFqnCBsd6RMkjVDRZzb', name: 'George', desc: 'British, male' },
      { id: 'IKne3meq5aSn9XLyUdCD', name: 'Charlie', desc: 'Australian, male' },
      { id: 'Xb7hH8MSUJpSbSDYk0k2', name: 'Alice', desc: 'British, female' },
      { id: 'onwK4e9ZLuTAKqWW03F9', name: 'Daniel', desc: 'British, male' },
      { id: 'nPczCjzI2devNBz1zQrb', name: 'Brian', desc: 'American, male' },
      { id: 'pFZP5JQG7iQjIQuC4Bku', name: 'Lily', desc: 'British, female' }
    ];
    const EL = {
      segs: [], voices: null,
      cur: -1, rec: null, url: null,      // the segment currently loaded in the <audio> element
      raf: 0, lastK: -1,
      dirty: true,                        // voice/model/root changed: loaded audio is stale
      seeked: true,                       // position moved since last play: don't resume in place
      pending: new Map(), mem: new Map(), creditTimer: 0
    };
    const audio = new Audio();
    audio.preload = 'auto';

    const apiKey = () => (store.get('elKey') || '').trim();
    const elModel = () => ui.model.value;

    class ElError extends Error { constructor(kind, msg) { super(msg); this.kind = kind; } }

    function hash(str) {   // cyrb53 — cache key for generated audio
      let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
      for (let i = 0; i < str.length; i++) {
        const ch = str.charCodeAt(i);
        h1 = Math.imul(h1 ^ ch, 2654435761); h2 = Math.imul(h2 ^ ch, 1597334677);
      }
      h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
      h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
      return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
    }

    // persistent audio cache (IndexedDB); silently falls back to memory only
    const idb = (() => {
      let dbp = null;
      const open = () => dbp || (dbp = new Promise((res, rej) => {
        const r = indexedDB.open('read-along', 1);
        r.onupgradeneeded = () => r.result.createObjectStore('audio');
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      }));
      return {
        async get(k) {
          try {
            const db = await open();
            return await new Promise((res) => {
              const q = db.transaction('audio').objectStore('audio').get(k);
              q.onsuccess = () => res(q.result || null);
              q.onerror = () => res(null);
            });
          } catch { return null; }
        },
        async put(k, v) {
          try { const db = await open(); db.transaction('audio', 'readwrite').objectStore('audio').put(v, k); } catch { /* ignore */ }
        }
      };
    })();

    function b64ToBlob(b64, type) {
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return new Blob([bytes], { type });
    }

    // A tiny silent WAV, played inside the click handler so Safari lets us play audio later.
    const SILENT_WAV = (() => {
      const n = 800, buf = new ArrayBuffer(44 + n), v = new DataView(buf);
      const w = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
      w(0, 'RIFF'); v.setUint32(4, 36 + n, true); w(8, 'WAVE'); w(12, 'fmt ');
      v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
      v.setUint32(24, 8000, true); v.setUint32(28, 8000, true); v.setUint16(32, 1, true); v.setUint16(34, 8, true);
      w(36, 'data'); v.setUint32(40, n, true);
      for (let i = 0; i < n; i++) v.setUint8(44 + i, 128);
      let s = '';
      new Uint8Array(buf).forEach((b) => { s += String.fromCharCode(b); });
      return 'data:audio/wav;base64,' + btoa(s);
    })();
    let unlocked = false;
    function unlockAudio() {
      if (unlocked) return;
      unlocked = true;
      try {
        audio.src = SILENT_WAV;
        const p = audio.play();
        if (p) p.then(() => { if (audio.src === SILENT_WAV) audio.pause(); }, () => {});
      } catch { /* ignore */ }
    }

    // Group sentences into synthesis segments: one paragraph (or ≤1200 chars of it) per request.
    function buildSegments() {
      EL.segs = []; EL.pending.clear(); EL.cur = -1; EL.rec = null; EL.dirty = true; EL.seeked = true;
      let seg = null;
      chunks.forEach((c, i) => {
        if (!seg || seg.block !== c.block || c.stops || c.inBlock !== chunks[i - 1].inBlock || c.end - seg.start > 1200) {
          seg = { block: c.block, start: c.start, end: c.end, c0: i, c1: i };
          EL.segs.push(seg);
        } else {
          seg.end = c.end; seg.c1 = i;
        }
        c.seg = EL.segs.length - 1;
      });
      for (const s of EL.segs) s.text = s.block.text.slice(s.start, s.end).replace(/\s/g, ' ');   // same length
    }

    function chunkInSeg(seg, bOff) {
      let ci = seg.c0;
      for (let k = seg.c0; k <= seg.c1; k++) { if (chunks[k].start <= bOff) ci = k; else break; }
      return ci;
    }

    async function apiError(res) {
      let detail = '';
      try {
        const j = await res.json();
        const d = j.detail;
        detail = (d && (d.message || d.status)) || (typeof d === 'string' ? d : '') || '';
      } catch { /* not JSON */ }
      if (/quota|credit/i.test(detail) || res.status === 402) {
        return new ElError('quota', 'You are out of ElevenLabs credits for this month. Switch Engine to "System voice" in Settings to keep listening.');
      }
      if (res.status === 401) return new ElError('auth', 'ElevenLabs rejected the API key. Check it under Settings.' + (detail ? ' (' + detail + ')' : ''));
      if (res.status === 429) return new ElError('busy', 'ElevenLabs is busy or rate-limiting. Try again in a moment.');
      return new ElError('api', 'ElevenLabs error ' + res.status + (detail ? ': ' + detail : ''));
    }

    function fetchSeg(i) {
      if (EL.pending.has(i)) return EL.pending.get(i);
      const seg = EL.segs[i];
      const voice = ui.voice.value, model = elModel(), key = apiKey();
      const p = (async () => {
        const ck = hash(model + '|' + voice + '|' + seg.text);
        let rec = EL.mem.get(ck) || await idb.get(ck);
        if (!rec) {
          let res;
          try {
            res = await fetch(`${EL_API}/text-to-speech/${encodeURIComponent(voice)}/with-timestamps?output_format=mp3_44100_128`, {
              method: 'POST',
              headers: { 'xi-api-key': key, 'Content-Type': 'application/json' },
              body: JSON.stringify({ text: seg.text, model_id: model })
            });
          } catch {
            throw new ElError('network', 'Could not reach ElevenLabs. Check your connection and try again.');
          }
          if (!res.ok) throw await apiError(res);
          const j = await res.json();
          const al = j.alignment || j.normalized_alignment || {};
          rec = {
            audio: b64ToBlob(j.audio_base64, 'audio/mpeg'),
            starts: al.character_start_times_seconds || []
          };
          idb.put(ck, rec);
          clearTimeout(EL.creditTimer);
          EL.creditTimer = setTimeout(refreshCredits, 1500);
        }
        EL.mem.set(ck, rec);
        return rec;
      })();
      EL.pending.set(i, p);
      p.catch(() => EL.pending.delete(i));
      return p;
    }

    const prefetch = (i) => { if (i < EL.segs.length) fetchSeg(i).catch(() => {}); };

    // The next n segments that will actually play after segment i (skipped ones are never fetched).
    function upcoming(i, n) {
      const out = [];
      let ci = EL.segs[i].c1 + 1;
      while (out.length < n) {
        ci = readable(ci);
        if (ci >= chunks.length) break;
        out.push(chunks[ci].seg);
        ci = EL.segs[chunks[ci].seg].c1 + 1;
      }
      return out;
    }

    // char offset within a segment <-> time in its audio
    function timeAtOffset(rec, k, len) {
      const n = rec.starts.length;
      if (!n) return (isFinite(audio.duration) ? audio.duration : 0) * k / Math.max(1, len);
      const j = Math.max(0, Math.min(n - 1, n === len ? k : Math.round(k * n / len)));
      return rec.starts[j];
    }
    function offsetAtTime(rec, t, len) {
      const n = rec.starts.length;
      if (!n) {
        const d = isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 1;
        return Math.max(0, Math.min(len - 1, Math.floor(t / d * len)));
      }
      let lo = 0, hi = n - 1;
      while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (rec.starts[mid] <= t) lo = mid; else hi = mid - 1; }
      return n === len ? lo : Math.min(len - 1, Math.round(lo * len / n));
    }

    async function elPlaySeg(i, atOff = 0) {
      const myGen = ++gen;
      cancelAnimationFrame(EL.raf);
      EL.seeked = false;
      if (i >= EL.segs.length) { finish(); return; }
      if (skipped(EL.segs[i].c0)) {   // a skipped table or formula: play what follows it instead
        const n = readable(EL.segs[i].c0);
        if (n >= chunks.length) { finish(); return; }
        i = chunks[n].seg; atOff = chunks[n].start - EL.segs[i].start;
      }
      const seg = EL.segs[i];
      const bOff = seg.start + atOff;
      const ci = chunkInSeg(seg, bOff);
      pos = { ci, off: Math.max(0, bOff - chunks[ci].start) };
      paint(ci, bOff, null);

      let rec = (i === EL.cur && !EL.dirty && audio.src === EL.url) ? EL.rec : null;
      if (!rec) {
        const slow = setTimeout(() => { if (myGen === gen) setStatus('Generating audio…'); }, 300);
        try {
          rec = await fetchSeg(i);
        } catch (e) {
          clearTimeout(slow);
          if (myGen === gen) elFail(e);
          return;
        }
        clearTimeout(slow);
        if (myGen !== gen) return;
        if (ui.status.textContent === 'Generating audio…') setStatus('');
        if (EL.url) URL.revokeObjectURL(EL.url);
        EL.url = URL.createObjectURL(rec.audio);
        EL.cur = i; EL.rec = rec; EL.dirty = false;
        audio.src = EL.url;
        await new Promise((res) => {
          audio.addEventListener('loadedmetadata', res, { once: true });
          audio.addEventListener('error', res, { once: true });
        });
        if (myGen !== gen) return;
        if (isFinite(audio.duration) && audio.duration > 0) calibrate('eleven', seg.text.length, audio.duration);
      }
      audio.playbackRate = rate();
      audio.currentTime = timeAtOffset(rec, atOff, seg.text.length);
      EL.lastK = -1;
      try {
        await audio.play();
      } catch {
        if (myGen === gen) { setStatus('The browser blocked audio playback. Press Play again.'); pause(); }
        return;
      }
      if (myGen !== gen) { audio.pause(); return; }
      EL.raf = requestAnimationFrame(elTick);
      upcoming(i, 2).forEach(prefetch);
    }

    function elTick() {
      if (!playing || engine() !== 'eleven' || EL.cur < 0 || !EL.rec) return;
      const seg = EL.segs[EL.cur];
      const k = offsetAtTime(EL.rec, audio.currentTime, seg.text.length);
      if (k !== EL.lastK) {
        EL.lastK = k;
        const t = seg.block.text, bOff = seg.start + k;
        const ci = chunkInSeg(seg, bOff), c = chunks[ci];
        let ws = Math.max(c.start, Math.min(bOff, c.end)), we = ws;
        while (ws > c.start && !/\s/.test(t[ws - 1])) ws--;
        while (we < c.end && !/\s/.test(t[we])) we++;
        if (we <= ws) we = Math.min(c.end, ws + 1);
        pos = { ci, off: ws - c.start };
        paint(ci, we, [ws, we]);
      }
      EL.raf = requestAnimationFrame(elTick);
    }

    function elResume() {
      const c = chunks[pos.ci], s = c.seg, seg = EL.segs[s];
      const canResumeInPlace = s === EL.cur && !EL.dirty && !EL.seeked && EL.rec && audio.src === EL.url && !audio.ended;
      if (!canResumeInPlace) { elPlaySeg(s, c.start + pos.off - seg.start); return; }
      const myGen = ++gen;
      audio.playbackRate = rate();
      audio.play().then(() => {
        if (myGen !== gen) { audio.pause(); return; }
        EL.lastK = -1;
        EL.raf = requestAnimationFrame(elTick);
        upcoming(s, 1).forEach(prefetch);
      }, () => { if (myGen === gen) { setStatus('The browser blocked audio playback. Press Play again.'); pause(); } });
    }

    function elHalt() {
      audio.pause();
      cancelAnimationFrame(EL.raf);
    }

    function elFail(e) {
      setStatus(e && e.message ? e.message : String(e));
      if (e && e.kind === 'auth') openSettings(null, true);
      playing = false; gen++;
      elHalt(); stopTicker(); updateButtons(); updateTime();
    }

    audio.addEventListener('ended', () => {
      if (!(playing && engine() === 'eleven' && EL.cur >= 0 && audio.src === EL.url)) return;
      const n = readable(EL.segs[EL.cur].c1 + 1);
      if (shouldStopAt(n)) stopAt(n);
      else if (n >= chunks.length) finish();
      else elPlaySeg(chunks[n].seg, chunks[n].start - EL.segs[chunks[n].seg].start);
    });
    audio.addEventListener('error', () => {
      if (playing && engine() === 'eleven' && audio.src === EL.url) { setStatus('Could not play the generated audio.'); pause(); }
    });

    async function fetchElVoices() {
      const key = apiKey();
      if (!key) return;
      try {
        const r = await fetch(`${EL_API}/voices`, { headers: { 'xi-api-key': key } });
        if (r.status === 401) { const e = await apiError(r); if (e.kind === 'auth') setStatus(e.message); throw e; }
        if (!r.ok) throw new Error(String(r.status));
        const j = await r.json();
        EL.voices = (j.voices || []).map((v) => ({
          id: v.voice_id,
          name: v.name,
          desc: [v.labels && v.labels.accent, v.labels && v.labels.gender].filter(Boolean).join(', ')
        })).sort((a, b) => a.name.localeCompare(b.name));
        if (!EL.voices.length) EL.voices = null;
      } catch {
        EL.voices = null;   // fall back to the built-in list
      }
      if (engine() === 'eleven') populateVoices();
    }

    async function refreshCredits() {
      const key = apiKey();
      if (!key) { ui.credits.textContent = ''; return; }
      try {
        const r = await fetch(`${EL_API}/user/subscription`, { headers: { 'xi-api-key': key } });
        if (!r.ok) return;
        const j = await r.json();
        if (typeof j.character_limit === 'number') {
          const left = Math.max(0, j.character_limit - (j.character_count || 0));
          ui.credits.textContent = `${left.toLocaleString()} of ${j.character_limit.toLocaleString()} credits left this month.`;
        }
      } catch { /* key may lack permission to read the account; not important */ }
    }

    // ======================================================================
    // 8. Transport: play / pause / stop / seek, for whichever engine is selected
    // ======================================================================
    const pauseBlocksOn = () => ui.pauseBlocks.checked;
    const shouldStopAt = (ci) => pauseBlocksOn() && ci > 0 && !!(chunks[ci] && chunks[ci].stops);
    // While pausing at blocks, sentences inside a table or display formula are skipped, not read.
    const skipped = (ci) => pauseBlocksOn() && !!(chunks[ci] && chunks[ci].inBlock);
    function readable(ci, dir = 1) { while (skipped(ci)) ci += dir; return ci; }
    // Stops are marked with an attribute, never a class: a class would break styles such as
    // Material's `table:not([class])` and change how the block looks.
    let stopMarked = [];
    function clearStopMark() { stopMarked.forEach((e) => e.removeAttribute('data-ra-stop')); stopMarked = []; }

    // Pause just before a code block / formula / table so it can be read.
    function stopAt(ci) {
      playing = false; gen++;
      if (synth) synth.cancel();
      elHalt(); stopTicker();
      pos = { ci, off: 0 };
      EL.seeked = true;
      updateButtons();
      const c = chunks[ci];
      paint(ci, c.start, null);
      clearStopMark();
      stopMarked = c.stops || [];
      stopMarked.forEach((e) => e.setAttribute('data-ra-stop', ''));
      if (stopMarked[0] && ui.follow.checked) stopMarked[0].scrollIntoView({ block: 'center', behavior: 'smooth' });
      updateTime();
      setStatus(`Paused at ${BLOCK_NAMES(stopMarked)}. Press Play (or Space) to continue.`);
    }

    function play() {
      if (!chunks.length || playing) return;
      clearStopMark();
      if (engine() === 'eleven') {
        if (!apiKey()) { openSettings('Paste your ElevenLabs API key first.'); return; }
        unlockAudio();
      } else if (!synth) {
        setStatus('This browser has no built-in speech. Choose ElevenLabs as the engine.');
        return;
      }
      const r = readable(pos.ci);
      if (r !== pos.ci) {   // parked inside a table or formula that is now skipped
        if (r >= chunks.length) { finish(); return; }
        pos = { ci: r, off: 0 }; EL.seeked = true;
      }
      playing = true;
      updateButtons(); setStatus(''); startTicker();
      if (engine() === 'eleven') elResume(); else speakFrom(pos.ci, pos.off);
    }

    function pause() {
      if (!playing) return;
      playing = false; gen++;
      if (synth) synth.cancel();
      elHalt();
      stopTicker(); updateButtons(); updateTime();
      const c = chunks[pos.ci];
      if (c) paint(pos.ci, c.start + pos.off, null);
    }

    function stop() {
      clearStopMark();
      playing = false; gen++;
      if (synth) synth.cancel();
      elHalt();
      EL.seeked = true;
      stopTicker();
      pos = { ci: 0, off: 0 };
      clearPaint(); updateButtons(); updateTime();
    }

    function finish() {
      playing = false; gen++;
      elHalt(); stopTicker();
      EL.seeked = true;
      pos = { ci: 0, off: 0 };
      clearPaint(); updateButtons(); updateTime();
      setStatus('Finished.');
    }

    function seekChunk(ci) {
      if (!chunks.length) return;
      ci = Math.max(0, Math.min(chunks.length - 1, ci));
      if (skipped(ci)) {   // landed in a skipped table or formula: step past it in the direction of travel
        const dir = ci < pos.ci ? -1 : 1;
        let r = readable(ci, dir);
        if (r < 0 || r >= chunks.length) r = readable(ci, -dir);
        if (r < 0 || r >= chunks.length) return;
        ci = r;
      }
      pos = { ci, off: 0 };
      EL.seeked = true;
      clearStopMark();
      if (playing) {
        if (engine() === 'eleven') {
          const s = chunks[ci].seg;
          elPlaySeg(s, chunks[ci].start - EL.segs[s].start);
        } else {
          speakFrom(ci, 0);
        }
      } else {
        paint(ci, chunks[ci].start, null);
      }
      updateTime();
    }

    function prev() {
      seekChunk(pos.off > 15 ? pos.ci : pos.ci - 1);   // mid-sentence: restart it; otherwise go back one
    }

    // ======================================================================
    // 9. Time display & scrubber
    // ======================================================================
    let ticker = null, scrubbing = false;
    function startTicker() { if (!ticker) ticker = setInterval(updateTime, 200); }
    function stopTicker() { clearInterval(ticker); ticker = null; }

    function currentChar() {
      const c = chunks[pos.ci];
      if (!c) return 0;
      let within = pos.off;
      if (engine() === 'system' && playing && !sawBoundary && utterStart) {
        within = Math.min(c.text.length, speakOff + (performance.now() - utterStart) / 1000 * cps());
      }
      return c.cum + within;
    }

    function updateTime(atChar) {
      const cur = atChar ?? currentChar();
      if (!scrubbing) ui.scrub.value = cur;
      ui.time.textContent = fmt(cur / cps()) + ' / ' + fmt(totalChars / cps());
    }

    function chunkAtChar(v) {
      let i = 0;
      for (let k = 0; k < chunks.length; k++) { if (chunks[k].cum <= v) i = k; else break; }
      return i;
    }

    ui.scrub.addEventListener('pointerdown', () => { scrubbing = true; });
    ui.scrub.addEventListener('input', () => { scrubbing = true; updateTime(+ui.scrub.value); });
    ui.scrub.addEventListener('change', () => {
      scrubbing = false;
      seekChunk(chunkAtChar(+ui.scrub.value));
      ui.scrub.blur();
    });

    function updateButtons() {
      const has = chunks.length > 0;
      ui.play.innerHTML = playing ? ICON_PAUSE : ICON_PLAY;
      for (const id of ['play', 'prev', 'next', 'stop']) ui[id].disabled = !has;
    }

    // ======================================================================
    // 10. Voices, engine & settings
    // ======================================================================
    function populateVoices() {
      const sel = ui.voice;
      if (engine() === 'eleven') {
        const list = EL.voices || EL_FALLBACK_VOICES;
        sel.innerHTML = list.map((v) =>
          `<option value="${escapeHtml(v.id)}">${escapeHtml(v.name)}${v.desc ? ' · ' + escapeHtml(v.desc) : ''}</option>`
        ).join('');
        const saved = store.get('elVoice');
        if (saved && list.some((v) => v.id === saved)) sel.value = saved;
        return;
      }
      const vs = synth ? synth.getVoices() : [];
      const score = (v) => (/^en/i.test(v.lang) ? 2 : 0) + (v.localService ? 1 : 0) + (v.default ? 0.5 : 0);
      const sorted = [...vs].sort((a, b) => score(b) - score(a) || a.name.localeCompare(b.name));
      sel.innerHTML = sorted.map((v) =>
        `<option value="${escapeHtml(v.voiceURI)}">${escapeHtml(v.name)} · ${escapeHtml(v.lang)}${v.localService ? '' : ' (online)'}</option>`
      ).join('');
      const saved = store.get('voice');
      if (saved && sorted.some((v) => v.voiceURI === saved)) sel.value = saved;
    }

    function docSummary() {
      if (!chunks.length) return 'Nothing to read in this document.';
      let s = `${chunks.length} sentences. Space to play, double-click a sentence to start there.`;
      if (engine() === 'eleven') {
        const credits = Math.ceil(totalChars * (EL_COST[elModel()] || 1));
        s += ` Reading it all with ElevenLabs costs about ${credits.toLocaleString()} credits; replays are free (audio is cached).`;
      }
      return s;
    }

    function renderKeyStatus() {
      const k = apiKey();
      ui.keyStatus.textContent = k ? `API key saved (…${k.slice(-4)})` : 'No API key yet';
      ui.changeKey.textContent = k ? 'Change key' : 'Add key';
    }
    function showKeyRow(show) {
      ui.keyRow.hidden = !show;
      if (show) { ui.apikey.value = ''; ui.apikey.focus(); }
    }
    function openSettings(msg, needKey = true) {
      ui.settings.hidden = false;
      renderKeyStatus();
      if (needKey) showKeyRow(true);
      if (msg) setStatus(msg);
    }
    function closeSettings() { ui.settings.hidden = true; showKeyRow(false); }

    // restart from the current spot (after a voice/model change)
    function restartHere() {
      if (!playing) return;
      if (engine() === 'eleven') {
        const c = chunks[pos.ci], s = c.seg;
        elPlaySeg(s, c.start + pos.off - EL.segs[s].start);
      } else {
        speakFrom(pos.ci, pos.off);
      }
    }

    ui.engine.addEventListener('change', () => {
      if (playing) pause();
      store.set('engine', engine());
      EL.seeked = true;
      populateVoices(); updateTime();
      if (engine() === 'eleven' && !apiKey()) openSettings('Paste your ElevenLabs API key to use ElevenLabs voices.');
      else setStatus(docSummary());
    });
    ui.voice.addEventListener('change', () => {
      if (engine() === 'eleven') {
        store.set('elVoice', ui.voice.value);
        EL.dirty = true; EL.pending.clear();
      } else {
        store.set('voice', ui.voice.value);
        warnedNoBoundary = false;
      }
      restartHere();
    });
    ui.model.addEventListener('change', () => {
      store.set('elModel', elModel());
      EL.dirty = true; EL.pending.clear();
      if (engine() === 'eleven') { restartHere(); if (!playing) setStatus(docSummary()); }
    });
    ui.rate.addEventListener('change', () => {
      store.set('rate', ui.rate.value);
      if (engine() === 'eleven') audio.playbackRate = rate();   // no new audio needed
      else if (playing) speakFrom(pos.ci, pos.off);
      updateTime();
    });
    ui.follow.addEventListener('change', () => store.set('follow', ui.follow.checked ? '1' : '0'));
    ui.gear.addEventListener('click', () => {
      if (ui.settings.hidden) openSettings(null, !apiKey()); else closeSettings();
    });
    ui.changeKey.addEventListener('click', () => showKeyRow(ui.keyRow.hidden));
    ui.cancelKey.addEventListener('click', () => showKeyRow(false));
    const pauseBoxes = [ui.pauseBlocks, ui.pauseBlocks2].filter(Boolean);   // one in the player, optionally one in Settings
    const syncPause = (v) => { pauseBoxes.forEach((b) => { b.checked = v; }); store.set('pauseBlocks', v ? '1' : '0'); };
    pauseBoxes.forEach((b) => b.addEventListener('change', (e) => syncPause(e.target.checked)));
    ui.saveKey.addEventListener('click', async () => {
      const k = ui.apikey.value.trim().replace(/^["']|["']$/g, '');
      if (!k) { setStatus('Paste a key first.'); return; }
      if (!/^sk_/.test(k)) {
        setStatus('That doesn\'t look like an API key. Keys start with "sk_" and are shown only once, when the key is created.');
        return;
      }
      store.set('elKey', k);
      ui.apikey.value = '';
      EL.voices = null; EL.dirty = true; EL.pending.clear();
      if (engine() !== 'eleven') { ui.engine.value = 'eleven'; store.set('engine', 'eleven'); }
      renderKeyStatus();
      setStatus('Checking the key with ElevenLabs…');
      try {
        const r = await fetch(`${EL_API}/voices`, { headers: { 'xi-api-key': k } });
        if (!r.ok) {
          const e = await apiError(r);
          setStatus(e.message + (/permission/i.test(e.message) ? ' The key needs "Text to Speech" and "Voices: read" access.' : ''));
          showKeyRow(true);
          return;
        }
      } catch {
        setStatus('Key saved, but ElevenLabs could not be reached to check it.');
      }
      closeSettings();
      populateVoices();
      fetchElVoices(); refreshCredits();
      setStatus('Key saved. ' + docSummary());
    });
    ui.apikey.addEventListener('keydown', (e) => { if (e.key === 'Enter') ui.saveKey.click(); });


    // ======================================================================
    // 12. Interaction: buttons, keyboard, double-click to jump
    // ======================================================================
    ui.play.addEventListener('click', () => (playing ? pause() : play()));
    ui.prev.addEventListener('click', prev);
    ui.next.addEventListener('click', () => seekChunk(pos.ci + 1));
    ui.stop.addEventListener('click', stop);

    document.addEventListener('keydown', (e) => {
      const t = e.target;
      if (t.closest && t.closest('input, select, textarea')) return;
      if (!opts.keys(e)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.code === 'Space') {
        if (t.closest && t.closest('button, label')) return;   // let the focused button handle it
        e.preventDefault(); playing ? pause() : play();
      } else if (e.key === 'ArrowRight') { e.preventDefault(); seekChunk(pos.ci + 1); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); prev(); }
      else if (e.key === 'Escape') { stop(); }
    });

    function caretAt(x, y) {
      if (document.caretPositionFromPoint) {
        const p = document.caretPositionFromPoint(x, y);
        return p && { node: p.offsetNode, offset: p.offset };
      }
      if (document.caretRangeFromPoint) {
        const r = document.caretRangeFromPoint(x, y);
        return r && { node: r.startContainer, offset: r.startOffset };
      }
      return null;
    }

    function chunkAtPoint(x, y) {
      const p = caretAt(x, y);
      if (!p || !root.contains(p.node)) return null;
      let blk = null, off = 0;
      outer: for (const b of blocks) {
        for (const s of b.segs) {
          if (s.node === p.node) { blk = b; off = s.start + Math.min(p.offset, s.end - s.start); break outer; }
          if (s.math && s.node.contains(p.node)) { blk = b; off = s.start; break outer; }
        }
      }
      if (!blk) {
        const el = (p.node.nodeType === 1 ? p.node : p.node.parentElement).closest(BLOCK_SEL);
        blk = blocks.find((b) => b.el === el) || null;
      }
      if (!blk) return null;
      let best = null;
      chunks.forEach((c, i) => {
        if (c.block !== blk) return;
        if (best === null || c.start <= off) best = i;
      });
      return best;
    }

    root.addEventListener('dblclick', (e) => {
      if (e.target.closest('a') || !opts.keys(e)) return;
      const ci = chunkAtPoint(e.clientX, e.clientY);
      if (ci == null) return;
      const sel = window.getSelection();
      if (sel) sel.removeAllRanges();
      seekChunk(ci);
      if (!playing) play();
    });

    window.addEventListener('pagehide', () => { if (synth) synth.cancel(); audio.pause(); });

    // ======================================================================
    // 13. Start-up: restore settings
    // ======================================================================
    ui.engine.value = store.get('engine') || (apiKey() || !synth ? 'eleven' : 'system');
    ui.model.value = store.get('elModel') || 'eleven_flash_v2_5';
    if (!ui.model.value) ui.model.value = 'eleven_flash_v2_5';
    renderKeyStatus();
    syncPause(store.get('pauseBlocks') === '1');
    const savedRate = store.get('rate');
    if (savedRate) ui.rate.value = savedRate;
    if (store.get('follow') === '0') ui.follow.checked = false;

    populateVoices();
    if (synth) {
      const onVoices = () => { if (engine() === 'system') populateVoices(); };
      if (synth.addEventListener) synth.addEventListener('voiceschanged', onVoices);
      else synth.onvoiceschanged = onVoices;
    }
    if (apiKey()) { fetchElVoices(); refreshCredits(); }
    updateButtons();

    // (Re)build the model from the root's current content.
    function refresh() {
      stop();
      buildModel();
      buildSegments();
      ui.scrub.max = String(totalChars);
      updateButtons(); updateTime();
    }

    return {
      refresh, play, pause, stop, setStatus, openSettings,
      summary: docSummary,
      isPlaying: () => playing,
      needsKey: () => engine() === 'eleven' && !apiKey(),
      speakMath
    };
  }

  window.ReadAlong = { create };
})();

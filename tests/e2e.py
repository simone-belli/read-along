"""End-to-end tests for Read Along (index.html), run in headless Chromium.

ElevenLabs is simulated: every request to api.elevenlabs.io is answered locally
with real (silent) audio plus per-character timings, so the tests cost no credits
and need no API key.

Setup (once):
    pip install playwright && playwright install chromium
    cd tests && npm install          # optional: serves the CDN libraries locally

Run from the repo root:
    python3 tests/e2e.py             # exits 0 when every check passes
"""
import base64, io, json, pathlib, sys, wave

from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
PAGE = (ROOT / 'index.html').as_uri()
LIBS = ROOT / 'tests' / 'node_modules'
CHARS_PER_SEC = 30          # speaking rate of the fake voice (fast, so tests stay quick)

# ----------------------------------------------------------------------------- helpers

_audio = {}
def silent_wav(seconds):
    """Base64 WAV of the given length (8 kHz, 8-bit mono silence)."""
    key = round(seconds, 1)
    if key not in _audio:
        buf = io.BytesIO()
        with wave.open(buf, 'wb') as w:
            w.setnchannels(1); w.setsampwidth(1); w.setframerate(8000)
            w.writeframes(b'\x80' * int(8000 * key))
        _audio[key] = base64.b64encode(buf.getvalue()).decode()
    return _audio[key]

CORS = {'Access-Control-Allow-Origin': '*'}

class FakeElevenLabs:
    """Answers the three endpoints the page calls. Set .reject_key to simulate a bad key."""
    def __init__(self):
        self.tts_calls = []
        self.reject_key = False

    def __call__(self, route, request):
        url = request.url
        if self.reject_key or request.headers.get('xi-api-key') != 'sk_test':
            return route.fulfill(status=401, content_type='application/json', headers=CORS,
                                 body=json.dumps({'detail': {'status': 'invalid_api_key', 'message': 'Invalid API key'}}))
        if url.endswith('/v1/voices'):
            return route.fulfill(status=200, content_type='application/json', headers=CORS, body=json.dumps({'voices': [
                {'voice_id': 'v_charlie', 'name': 'Charlie', 'labels': {'accent': 'Australian', 'gender': 'male'}},
                {'voice_id': 'v_alice', 'name': 'Alice', 'labels': {'accent': 'British', 'gender': 'female'}}]}))
        if url.endswith('/v1/user/subscription'):
            return route.fulfill(status=200, content_type='application/json', headers=CORS,
                                 body=json.dumps({'character_count': 1200, 'character_limit': 10000}))
        if '/with-timestamps' in url:
            body = json.loads(request.post_data)
            text = body['text']
            self.tts_calls.append((url, body))
            dur = max(0.6, len(text) / CHARS_PER_SEC)
            step = dur / len(text)
            al = {'characters': list(text),
                  'character_start_times_seconds': [i * step for i in range(len(text))],
                  'character_end_times_seconds': [(i + 1) * step for i in range(len(text))]}
            return route.fulfill(status=200, content_type='application/json', headers=CORS,
                                 body=json.dumps({'audio_base64': silent_wav(dur), 'alignment': al}))
        return route.fulfill(status=404, headers=CORS, body='')


def serve_local_libs(page):
    """Serve markdown-it and MathJax from tests/node_modules when installed; otherwise use the CDNs."""
    def from_dir(base, prefix):
        def handler(route, request):
            rel = request.url.split(prefix, 1)[1].split('?')[0]
            f = base / rel
            if f.is_file():
                ctype = 'text/javascript' if rel.endswith('.js') else 'application/octet-stream'
                return route.fulfill(status=200, content_type=ctype, body=f.read_bytes())
            return route.continue_()
        return handler
    if (LIBS / 'markdown-it').is_dir():
        page.route('https://cdn.jsdelivr.net/npm/markdown-it@14.1.0/**',
                   from_dir(LIBS / 'markdown-it', '/npm/markdown-it@14.1.0/'))
    if (LIBS / 'mathjax').is_dir():
        page.route('https://cdn.jsdelivr.net/npm/mathjax@3/**', from_dir(LIBS / 'mathjax', '/npm/mathjax@3/'))


results = []
def check(cond, label):
    results.append(bool(cond))
    print(('PASS ' if cond else 'FAIL ') + label)


def open_page(browser, key=None):
    """New page with the fake API; key=None starts with empty storage."""
    page = browser.new_page(viewport={'width': 1100, 'height': 760})
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    fake = FakeElevenLabs()
    serve_local_libs(page)
    page.route('https://api.elevenlabs.io/**', fake)
    if key:
        page.add_init_script(f"try{{localStorage.setItem('readalong.elKey','{key}')}}catch(e){{}}")
    page.goto(PAGE)
    page.wait_for_function("document.getElementById('status').textContent.includes('sentences')", timeout=20000)
    return page, fake, errors


def scrub_to(page, fraction):
    page.evaluate(f"""() => {{ const s = document.getElementById('scrub');
        s.value = Math.floor(s.max * {fraction}); s.dispatchEvent(new Event('change')); }}""")


WORD = "[...CSS.highlights.get('tts-word')].map(r => r.toString())"
SENTENCE = "[...CSS.highlights.get('tts-sentence')].map(r => r.toString())[0] || ''"

# ----------------------------------------------------------------------------- tests

def test_rendering_and_playback(browser):
    print('\n# Rendering and ElevenLabs playback')
    page, fake, errors = open_page(browser, key='sk_test')
    check(page.locator('mjx-container').count() >= 3, 'LaTeX is rendered by MathJax')
    check(page.is_visible('#hero .logo') and page.locator('.credit .logo').count() == 1, 'the logo is shown on the welcome page and in the footer')
    check(page.evaluate("document.querySelector('.brand .logo').getBoundingClientRect().width") > 0, 'the toolbar logo renders from the shared symbol')
    check('credits' in page.text_content('#status'), 'cost estimate is shown for ElevenLabs')
    check(page.eval_on_selector('#engine', 'e => e.value') == 'eleven', 'engine defaults to ElevenLabs when a key is saved')
    page.wait_for_function("[...document.querySelectorAll('#voice option')].some(o => o.value === 'v_charlie')", timeout=5000)
    check(True, 'voice list is fetched from ElevenLabs')
    check(page.is_hidden('#settings'), 'settings stay hidden when a key is already saved')
    check(page.is_hidden('#engine') and page.is_hidden('#voice'), 'engine and voice pickers live in settings, not the toolbar')

    page.click('#gear')
    page.select_option('#voice', 'v_charlie')
    page.click('#gear')
    page.click('#play')
    page.wait_for_timeout(1500)
    w1 = page.evaluate(WORD)
    check(w1 and w1[0].strip(), 'word highlight follows the audio')
    check(fake.tts_calls and 'v_charlie' in fake.tts_calls[0][0], 'request uses the chosen voice')
    check(fake.tts_calls and fake.tts_calls[0][1]['model_id'] == 'eleven_flash_v2_5', 'request uses the Flash model by default')
    check(len(fake.tts_calls) >= 2, 'next paragraphs are generated ahead of time')
    page.wait_for_timeout(1200)
    check(page.evaluate(WORD) != w1, 'highlight advances')

    page.keyboard.press('Space')
    t = page.text_content('#time')
    page.wait_for_timeout(700)
    check(page.text_content('#time') == t, 'Space pauses and holds the position')
    n = len(fake.tts_calls)
    page.keyboard.press('Space')
    page.wait_for_timeout(800)
    check(len(fake.tts_calls) <= n + 2, 'resuming does not regenerate audio')

    before = page.evaluate(SENTENCE)
    page.keyboard.press('ArrowRight')
    page.wait_for_timeout(900)
    check(page.evaluate(SENTENCE) != before, 'right arrow jumps to the next sentence')

    scrub_to(page, 0.62)
    page.wait_for_timeout(1500)
    check(page.evaluate("document.querySelectorAll('.math.read').length") >= 1, 'formulas before the cursor are marked as read')

    calls = len(fake.tts_calls)
    page.keyboard.press('Escape')
    page.click('#play')
    page.wait_for_timeout(1200)
    check(len(fake.tts_calls) == calls, 'replaying cached audio makes no new API calls')
    page.keyboard.press('Escape')

    fake.reject_key = True
    page.click('#gear')
    check(not page.is_hidden('#voice'), 'the gear reveals the voice picker')
    page.select_option('#model', 'eleven_multilingual_v2')     # forces fresh generation
    page.click('#play')
    page.wait_for_timeout(1000)
    st = page.text_content('#status')
    check('rejected' in st and not page.is_hidden('#keyRow'), 'a rejected key gives a clear message and offers the key field')
    check(not errors, 'no script errors' + (f': {errors}' if errors else ''))
    page.close()


def test_key_handling(browser):
    print('\n# API key handling')
    page, fake, errors = open_page(browser)
    check(page.is_hidden('#settings'), 'with no key, the page starts on the system voice with settings closed')
    page.click('#gear')
    page.select_option('#engine', 'eleven')
    check(not page.is_hidden('#keyRow'), 'choosing ElevenLabs without a key offers the key field')
    page.fill('#apikey', 'abc123')
    page.click('#saveKey')
    check('start with "sk_"' in page.text_content('#status'), 'a key ID or other non-key is caught with a hint')
    page.fill('#apikey', 'sk_test')
    page.click('#saveKey')
    page.wait_for_timeout(800)
    check(page.is_hidden('#settings') and page.is_hidden('#keyRow'), 'after saving, the key and settings are hidden')
    page.click('#gear')
    check(not page.is_hidden('#settings') and page.is_hidden('#keyRow'), 'the gear shows settings without exposing the key field')
    check('(…test)' in page.text_content('#keyStatus'), 'settings show only the last 4 characters of the key')
    page.click('#changeKey')
    check(not page.is_hidden('#keyRow'), '"Change key" reveals the key field')
    page.click('#cancelKey')
    page.click('#gear')
    check(page.is_hidden('#settings'), 'the gear closes settings again')
    check(not errors, 'no script errors' + (f': {errors}' if errors else ''))
    page.close()


def test_pause_at_blocks(browser):
    print('\n# Pause at blocks')
    page, fake, errors = open_page(browser, key='sk_test')
    page.check('#pauseBlocks')
    page.click('#gear')
    check(page.is_checked('#pauseBlocks2'), 'toolbar and settings tick boxes stay in sync')
    page.click('#gear')
    page.select_option('#rate', '2')
    scrub_to(page, 0.5)
    page.click('#play')
    seen = []
    for _ in range(3):
        try:
            page.wait_for_function("document.getElementById('status').textContent.startsWith('Paused at')", timeout=25000)
        except Exception:
            break
        seen.append(page.text_content('#status'))
        page.wait_for_timeout(300)
        page.keyboard.press('Space')
        page.wait_for_function("!document.getElementById('status').textContent.startsWith('Paused at')", timeout=5000)
    check(any('formula' in s for s in seen), 'pauses before the display formula')
    check(any('code block' in s for s in seen), 'pauses before the code block')
    check(any('table' in s for s in seen), 'pauses before the table')

    page.keyboard.press('Escape')
    page.uncheck('#pauseBlocks')
    scrub_to(page, 0.5)
    page.click('#play')
    page.wait_for_timeout(6000)
    check(not page.text_content('#status').startswith('Paused at'), 'unticked, it reads straight through blocks')
    check(not errors, 'no script errors' + (f': {errors}' if errors else ''))
    page.close()


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(args=['--autoplay-policy=no-user-gesture-required'])
        for test in (test_rendering_and_playback, test_key_handling, test_pause_at_blocks):
            try:
                test(browser)
            except Exception as e:      # a crashed test counts as a failure, the rest still run
                check(False, f'{test.__name__} crashed: {e}')
        browser.close()
    failed = results.count(False)
    print(f'\n{len(results) - failed} passed, {failed} failed')
    sys.exit(1 if failed else 0)


if __name__ == '__main__':
    main()

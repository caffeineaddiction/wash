// Smoke test of Terminal + CanvasRenderer against a minimal fake DOM, to
// catch runtime errors in the drawing and input paths without a browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const calls = { fillText: 0, drawImage: 0, fillRect: 0 };

function ctx2d() {
  return new Proxy({}, {
    get(t, k) {
      if (k in t) return t[k];
      if (k === 'measureText') {
        // metrics scale with the font (15px: 9 wide, 18 high)
        const fs = Number(/(\d+(?:\.\d+)?)px/.exec(t.font || '15px')?.[1] || 15);
        return () => ({ width: fs * 9 / 15, fontBoundingBoxAscent: fs * 14 / 15, fontBoundingBoxDescent: fs * 4 / 15 });
      }
      return (...a) => { if (k in calls) calls[k]++; };
    },
    set(t, k, v) { t[k] = v; return true; },
  });
}

class El {
  constructor(tag) {
    this.tag = tag; this.style = {}; this.children = []; this.listeners = {}; this.attrs = {};
    this.width = 0; this.height = 0; this.clientWidth = 900; this.clientHeight = 360; this.value = '';
  }
  appendChild(c) { this.children.push(c); c.parent = this; return c; }
  remove() {}
  setAttribute(k, v) { this.attrs[k] = v; }
  addEventListener(ev, fn) { (this.listeners[ev] ||= []).push(fn); }
  removeEventListener() {}
  dispatch(ev, e) { for (const fn of this.listeners[ev] || []) fn({ preventDefault() {}, ...e }); }
  getContext() { return (this._ctx ||= ctx2d()); }
  getBoundingClientRect() { return { left: 0, top: 0, width: 900, height: 360 }; }
  focus() {} blur() {}
}

let rafQ = [];
globalThis.document = { createElement: (t) => new El(t) };
globalThis.window = new El('window');
window.devicePixelRatio = 1;
window.open = () => {};
globalThis.getComputedStyle = () => ({ position: 'static' });
globalThis.ResizeObserver = class { observe() {} disconnect() {} };
globalThis.requestAnimationFrame = (fn) => { rafQ.push(fn); return rafQ.length; };
globalThis.cancelAnimationFrame = () => {};
globalThis.createImageBitmap = async () => ({ width: 10, height: 10, close() {} });
globalThis.ImageData = class { constructor(d, w, h) { this.data = d; this.width = w; this.height = h; } };
if (!globalThis.navigator) globalThis.navigator = {};
const flush = () => { const q = rafQ; rafQ = []; q.forEach((f) => f()); };

const { Terminal } = await import('../../static/term/terminal.js');

test('terminal renders, resizes and encodes input', async () => {
  const el = new El('div');
  const t = new Terminal(el, { fontSize: 15 });
  const sent = [];
  let size = null;
  t.onData = (u8) => sent.push(new TextDecoder().decode(u8));
  t.onResize = (c, r) => { size = [c, r]; };
  await Promise.resolve();
  assert.deepEqual(size, [100, 20]); // 900/9, 360/18
  t.write(new TextEncoder().encode('hi \x1b[1;31mred\x1b[0m ┌─┐ ▄█ 中😀\r\n\x1b[4:3mcurly\x1b[0m'));
  // raw RGBA 2x2 image
  const px = Buffer.from(new Uint8Array(16).fill(200)).toString('base64');
  t.write(`\x1b_Ga=T,f=32,s=2,v=2,c=2,r=1;${px}\x1b\\`);
  await new Promise((r) => setTimeout(r, 5));
  flush();
  assert.ok(calls.fillText > 5, 'text drawn');
  assert.ok(calls.drawImage >= 1, 'image drawn');
  // a split UTF-8 sequence across writes
  const bytes = new TextEncoder().encode('é');
  t.write(bytes.subarray(0, 1));
  t.write(bytes.subarray(1));
  assert.equal(t.screen.buf.lines[1].text().includes('é'), true);
  // typing
  const ta = t.textarea;
  ta.dispatch('keydown', { key: 'a', code: 'KeyA' });
  ta.dispatch('keydown', { key: 'ArrowUp', code: 'ArrowUp' });
  ta.dispatch('keydown', { key: 'c', code: 'KeyC', ctrlKey: true });
  ta.dispatch('paste', { clipboardData: { getData: () => 'x\ny' } });
  assert.deepEqual(sent, ['a', '\x1b[A', '\x03', 'x\ry']);
  // terminal query reply goes to onData (curly + 2-col image + é)
  t.write('\x1b[6n');
  assert.equal(sent.at(-1), '\x1b[2;9R');
  // resize
  el.clientWidth = 450;
  t.fit();
  assert.deepEqual(size, [50, 20]);
  flush();
  // selection by drag
  t.canvas.dispatch('mousedown', { button: 0, detail: 1, clientX: 1, clientY: 1 });
  window.dispatch('mousemove', { clientX: 20, clientY: 1 });
  window.dispatch('mouseup', { clientX: 20, clientY: 1 });
  assert.equal(t.getSelection(), 'hi');
  flush();
  // mouse reporting
  t.write('\x1b[?1000h\x1b[?1006h');
  t.canvas.dispatch('mousedown', { button: 0, detail: 1, clientX: 10, clientY: 20 });
  window.dispatch('mouseup', { button: 0, clientX: 10, clientY: 20 });
  assert.deepEqual(sent.slice(-2), ['\x1b[<0;2;2M', '\x1b[<0;2;2m']);
  // sync output defers rendering
  t.write('\x1b[?2026h');
  const before = calls.fillText;
  t.write('more text');
  flush();
  assert.equal(calls.fillText, before);
  t.write('\x1b[?2026l');
  flush();
  assert.ok(calls.fillText > before);
  t.dispose();
});

test('fixed grid (watching a shared session): font shrinks to fit, never grows', async () => {
  const el = new El('div'); // 900 x 360
  const t = new Terminal(el, { fontSize: 15 });
  let resized = 0;
  t.onResize = () => { resized++; };
  await Promise.resolve();
  resized = 0;
  t.setFixedSize({ cols: 200, rows: 50 }); // a big desktop session watched on a small screen
  assert.equal(t.cols, 200); assert.equal(t.rows, 50);
  assert.ok(t._font < 15, `font ${t._font}`);
  const g = t.renderer.gridSize(900, 360);
  assert.ok(g.cols >= 200 && g.rows >= 50, `grid ${g.cols}x${g.rows} holds 200x50`);
  t.setFixedSize({ cols: 40, rows: 12 }); // a phone session watched on a big screen
  assert.equal(t._font, 15, 'never larger than the chosen font');
  assert.equal(t.cols, 40);
  assert.equal(resized, 0, 'a fixed grid is not reported as our size');
  t.setFixedSize(null); // took control: fit this screen again
  assert.equal(t.cols, 100); assert.equal(t.rows, 20);
  assert.equal(resized, 1);
  t.dispose();
});

test('on-screen keyboard backspace (Android): a delete in the textarea is DEL', async () => {
  const el = new El('div');
  const t = new Terminal(el, { fontSize: 15 });
  const sent = [];
  t.onData = (u8) => sent.push(new TextDecoder().decode(u8));
  const ta = t.textarea;
  assert.ok(ta.value.length > 0, 'the textarea keeps text to delete');
  // Gboard: keydown is keyCode 229 (ignored), then the IME deletes a character
  ta.dispatch('keydown', { key: 'Unidentified', keyCode: 229 });
  ta.value = ta.value.slice(0, -1);
  ta.dispatch('input', { inputType: 'deleteContentBackward' });
  ta.value = ta.value.slice(0, -1);
  ta.dispatch('input', { inputType: 'deleteContentBackward' });
  ta.dispatch('input', { inputType: 'deleteWordBackward' });
  ta.dispatch('input', { inputType: 'insertText', data: 'x' });
  assert.deepEqual(sent, ['\x7f', '\x7f', '\x17', 'x']);
  assert.equal(ta.value, '  ', 'refilled after each edit');
  t.dispose();
});

test('extra keys: sticky Ctrl/Alt, arrows, and live on-screen typing', async () => {
  const el = new El('div');
  const t = new Terminal(el, { fontSize: 15, liveIME: true });
  const sent = [];
  t.onData = (u8) => sent.push(new TextDecoder().decode(u8));
  const ta = t.textarea;
  let modsSeen = null;
  t.onMods = (m) => { modsSeen = { ...m }; };
  t.pressKey('Escape'); t.pressKey('Tab'); t.pressKey('ArrowUp'); t.pressKey('|');
  // Ctrl armed for one key, then typed on the soft keyboard: ^C, then plain
  t.setMod('ctrl', 1);
  ta.dispatch('input', { inputType: 'insertText', data: 'cd' });
  assert.deepEqual(modsSeen, { ctrl: 0, alt: 0 }, 'one-shot Ctrl is used up');
  // Alt locked: every key gets ESC-prefixed until released
  t.setMod('alt', 2);
  t.pressKey('b'); t.pressKey('f');
  t.setMod('alt', 0);
  // Gboard composes words: live mode sends letters as they come, and edits
  ta.dispatch('compositionstart', {});
  ta.dispatch('compositionupdate', { data: 'l' });
  ta.dispatch('compositionupdate', { data: 'ls' });
  ta.dispatch('compositionupdate', { data: 'l' }); // backspace inside the word
  ta.dispatch('compositionupdate', { data: 'll' });
  ta.dispatch('compositionend', { data: 'll' });
  // Ctrl then a letter while Gboard composes: ^C at once, not after a space
  t.setMod('ctrl', 1);
  ta.dispatch('compositionstart', {});
  ta.dispatch('compositionupdate', { data: 'c' });
  ta.dispatch('compositionend', { data: 'c' });
  assert.deepEqual(sent, ['\x1b', '\t', '\x1b[A', '|', '\x03', 'd', '\x1bb', '\x1bf',
    'l', 's', '\x7f', 'l', '\x03']);
  t.dispose();
});

test('touch: a vertical drag scrolls back, a tap focuses', async () => {
  const el = new El('div');
  const t = new Terminal(el, { fontSize: 15 });
  for (let i = 0; i < 100; i++) t.write(`line ${i}\r\n`);
  const c = t.canvas;
  let focused = 0;
  t.textarea.focus = () => { focused++; };
  const touch = (type, y) => {
    let prevented = false;
    c.dispatch(type, { touches: type === 'touchend' ? [] : [{ clientX: 50, clientY: y }], preventDefault() { prevented = true; } });
    return prevented;
  };
  touch('touchstart', 100);
  assert.equal(touch('touchmove', 104), false, 'small moves are not a drag yet');
  assert.equal(touch('touchmove', 160), true, 'a drag is ours (no page scroll / pull-to-refresh)');
  touch('touchmove', 280);
  touch('touchend', 280);
  assert.ok(t.screen.viewOffset >= 8, `scrolled back ${t.screen.viewOffset} lines`);
  assert.equal(focused, 0, 'a drag does not open the keyboard');
  touch('touchstart', 200); touch('touchend', 200);
  assert.equal(focused, 1, 'a tap focuses');
  t.dispose();
});

test('playback terminal: clicks select text even in mouse mode, no clipboard writes', () => {
  const el = new El('div');
  const t = new Terminal(el, { fontSize: 15, mouseReporting: false, clipboard: false });
  const sent = [];
  t.onData = (u8) => sent.push(new TextDecoder().decode(u8));
  let copied = null;
  const nav = globalThis.navigator;
  Object.defineProperty(globalThis, 'navigator', { value: { clipboard: { writeText: async (s) => { copied = s; } } }, configurable: true });
  try {
    t.write('\x1b[?1000h\x1b[?1006hhello world\x1b]52;c;aGk=\x07');
    flush();
    t.canvas.dispatch('mousedown', { button: 0, detail: 1, clientX: 1, clientY: 1 });
    window.dispatch('mousemove', { clientX: 40, clientY: 1 });
    window.dispatch('mouseup', { clientX: 40, clientY: 1 });
    assert.equal(sent.length, 0, 'no mouse reports');
    assert.match(t.getSelection(), /^hell/);
    assert.equal(copied, null, 'OSC 52 ignored');
  } finally {
    Object.defineProperty(globalThis, 'navigator', { value: nav, configurable: true });
  }
});

test('write with replies: false draws but does not answer queries', async () => {
  const el = new El('div');
  const t = new Terminal(el, { fontSize: 15 });
  const sent = [];
  t.onData = (u8) => sent.push(new TextDecoder().decode(u8));
  t.write('old\x1b[5n\x1b[c\x1b[>q\x1b]11;?\x07', { replies: false });
  assert.deepEqual(sent, [], 'replayed queries stay unanswered');
  assert.ok(t.screen.buf.lines[0].text().startsWith('old'), 'replayed text is drawn');
  t.write('\x1b[5n');
  assert.deepEqual(sent, ['\x1b[0n'], 'live queries are answered');
  t.dispose();
});

test('a write from a callback during a quiet write keeps the rest quiet', () => {
  const el = new El('div');
  const t = new Terminal(el, { fontSize: 15 });
  const sent = [];
  t.onData = (u8) => sent.push(new TextDecoder().decode(u8));
  t.onTitle = () => t.write('[t]');
  t.onBell = () => t.write('!');
  t.write('\x1b]0;title\x07\x1b[5n\x07\x1b[c', { replies: false });
  assert.deepEqual(sent, [], 'queries after the nested writes stay unanswered');
  t.write('\x1b[5n');
  assert.deepEqual(sent, ['\x1b[0n'], 'a live write still answers');
  t.dispose();
});

test('write with replies: false does not set the clipboard (OSC 52)', () => {
  const el = new El('div');
  const t = new Terminal(el, { fontSize: 15 });
  const copied = [];
  const nav = globalThis.navigator;
  Object.defineProperty(globalThis, 'navigator', { value: { clipboard: { writeText: async (s) => { copied.push(s); } } }, configurable: true });
  try {
    t.write('\x1b]52;c;b2xk\x07', { replies: false });
    assert.deepEqual(copied, [], 'a replayed yank leaves the clipboard alone');
    t.write('\x1b]52;c;bmV3\x07');
    assert.deepEqual(copied, ['new'], 'a live yank sets it');
  } finally {
    Object.defineProperty(globalThis, 'navigator', { value: nav, configurable: true });
    t.dispose();
  }
});

test('Ctrl+click opens OSC 8 links only for http and https', async () => {
  const el = new El('div');
  const t = new Terminal(el, { fontSize: 15 });
  const opened = [];
  const prev = window.open;
  window.open = (u) => { opened.push(u); };
  try {
    const click = () => {
      t.canvas.dispatch('mousedown', { button: 0, detail: 1, ctrlKey: true, clientX: 1, clientY: 1 });
      window.dispatch('mouseup', { button: 0, clientX: 1, clientY: 1 });
    };
    t.write('\x1b]8;;javascript:alert(1)\x07evil\x1b]8;;\x07\r');
    click();
    assert.deepEqual(opened, [], 'javascript: link not opened');
    t.write('\x1b]8;;https://example.com/x\x07good\x1b]8;;\x07\r');
    click();
    assert.deepEqual(opened, ['https://example.com/x']);
  } finally {
    window.open = prev;
    t.dispose();
  }
});

test('Ctrl+click opens a plain URL, also one wrapped across lines', async () => {
  const el = new El('div'); // 100 x 20 cells
  const t = new Terminal(el, { fontSize: 15 });
  const opened = [];
  const prev = window.open;
  window.open = (u) => { opened.push(u); };
  const click = (col, row) => {
    const x = col * 9 + 1, y = row * 18 + 1;
    t.canvas.dispatch('mousedown', { button: 0, detail: 1, ctrlKey: true, clientX: x, clientY: y });
    window.dispatch('mouseup', { button: 0, clientX: x, clientY: y });
  };
  try {
    t.write('see https://example.com/docs. ok\r\n');
    click(10, 0);
    assert.deepEqual(opened, ['https://example.com/docs']);
    click(1, 0);
    assert.equal(opened.length, 1, 'plain text is not a link');
    // 90 columns of text, then a URL that soft-wraps onto the next row
    t.write('x'.repeat(90) + ' https://example.com/' + 'long'.repeat(5) + '\r\n');
    click(3, 2);
    assert.deepEqual(opened.at(-1), 'https://example.com/' + 'long'.repeat(5), 'click on the wrapped half');
    click(95, 1);
    assert.equal(opened.length, 3, 'click on the first half');
    assert.equal(opened.at(-1), opened.at(-2));
  } finally {
    window.open = prev;
    t.dispose();
  }
});

test('Ctrl+click on a plain URL: concealed text, unsafe OSC 8', async () => {
  const el = new El('div'); // 100 x 20 cells
  const t = new Terminal(el, { fontSize: 15 });
  const opened = [];
  const prev = window.open;
  window.open = (u) => { opened.push(u); };
  const click = (col, row) => {
    const x = col * 9 + 1, y = row * 18 + 1;
    t.canvas.dispatch('mousedown', { button: 0, detail: 1, ctrlKey: true, clientX: x, clientY: y });
    window.dispatch('mouseup', { button: 0, clientX: x, clientY: y });
  };
  try {
    t.write('https://good.example\x1b[8m.evil.test/\x1b[0m\r\n');
    click(3, 0);
    assert.equal(opened.at(-1), 'https://good.example/', 'concealed text is not part of the URL');
    // an OSC 8 target that may not be opened falls back to the URL in its text
    t.write('\x1b]8;;javascript:alert(1)\x07https://example.com/t\x1b]8;;\x07\r\n');
    click(3, 1);
    assert.equal(opened.at(-1), 'https://example.com/t');
    assert.equal(opened.length, 2);
  } finally {
    window.open = prev;
    t.dispose();
  }
});

test('a plain click opens a link; Shift-click and clickOpensLinks: false do not', async () => {
  const el = new El('div'); // 100 x 20 cells, 9 x 18 px
  const t = new Terminal(el, { fontSize: 15 });
  const opened = [];
  const prev = window.open;
  window.open = (u) => { opened.push(u); };
  const click = (col, row, mods = {}) => {
    const x = col * 9 + 1, y = row * 18 + 1;
    t.canvas.dispatch('mousedown', { button: 0, detail: 1, clientX: x, clientY: y, ...mods });
    window.dispatch('mouseup', { button: 0, clientX: x, clientY: y });
  };
  try {
    t.write('go https://example.com/a now\r\n');
    t.write('\x1b]8;;javascript:alert(1)\x07evil\x1b]8;;\x07\r\n');
    click(5, 0);
    assert.deepEqual(opened, ['https://example.com/a'], 'plain click');
    click(0, 0);
    assert.equal(opened.length, 1, 'plain text is not a link');
    click(1, 1);
    assert.equal(opened.length, 1, 'an unsafe OSC 8 link still does not open');
    click(5, 0, { shiftKey: true });
    assert.equal(opened.length, 1, 'Shift-click only selects');
    t.setOptions({ clickOpensLinks: false });
    click(5, 0);
    assert.equal(opened.length, 1, 'off: a plain click does not open');
    click(5, 0, { ctrlKey: true });
    assert.equal(opened.length, 2, 'off: Ctrl+click still opens');
  } finally {
    window.open = prev;
    t.dispose();
  }
});

test('a tap on a link opens it without the keyboard; a tap elsewhere focuses', () => {
  const el = new El('div');
  const t = new Terminal(el, { fontSize: 15 });
  const opened = [];
  const prev = window.open;
  window.open = (u) => { opened.push(u); };
  let focused = 0;
  t.textarea.focus = () => { focused++; };
  const tap = (col, row) => {
    const x = col * 9 + 1, y = row * 18 + 1;
    let prevented = false;
    t.canvas.dispatch('touchstart', { touches: [{ clientX: x, clientY: y }] });
    t.canvas.dispatch('touchend', { touches: [], preventDefault() { prevented = true; } });
    return prevented;
  };
  try {
    t.write('see https://example.com/tap ok\r\n');
    assert.equal(tap(8, 0), true, 'no emulated click after the tap');
    assert.deepEqual(opened, ['https://example.com/tap']);
    assert.equal(focused, 0, 'the keyboard stays down');
    assert.equal(tap(0, 0), false);
    assert.equal(opened.length, 1);
    assert.equal(focused, 1, 'a tap off a link focuses');
    t.write('\x1b[?1000h'); // the program reports the mouse: the tap is its click
    tap(8, 0);
    assert.equal(opened.length, 1, 'mouse mode: no link');
  } finally {
    window.open = prev;
    t.dispose();
  }
});

test('hover: pointer cursor and underline over plain URLs and OSC 8 links', async () => {
  const el = new El('div'); // 100 x 20 cells of 9 x 18 px
  const t = new Terminal(el, { fontSize: 15 });
  const at = (col, row, mods = {}) => t.canvas.dispatch('mousemove', { clientX: col * 9 + 1, clientY: row * 18 + 1, ...mods });
  try {
    t.write('see https://example.com/docs. ok\r\n');
    t.write('\x1b]8;;https://example.com/x\x07click here\x1b]8;;\x07 after\r\n');
    flush();
    at(10, 0);
    assert.equal(t.canvas.style.cursor, 'pointer');
    assert.deepEqual(t.renderer.hover, { url: 'https://example.com/docs', start: { abs: 0, col: 4 }, end: { abs: 0, col: 28 } });
    flush(); // draws the underline without error
    at(1, 0);
    assert.equal(t.canvas.style.cursor, '');
    assert.equal(t.renderer.hover, null);
    at(3, 1); // inside the OSC 8 text
    assert.deepEqual(t.renderer.hover, { url: 'https://example.com/x', start: { abs: 1, col: 0 }, end: { abs: 1, col: 10 } });
    at(12, 1); // " after" is not part of it
    assert.equal(t.renderer.hover, null);
    at(10, 0);
    t.canvas.dispatch('mouseleave', {});
    assert.equal(t.renderer.hover, null);
    assert.equal(t.canvas.style.cursor, '');
    // new output under the pointer: the hover follows on the next frame
    at(10, 0);
    t.write('\x1b[2J\x1b[H');
    flush();
    assert.equal(t.renderer.hover, null, 'cleared screen: no link under the pointer');
  } finally {
    t.dispose();
  }
});

test('mouse reporting: hover and click need Ctrl/Cmd; a plain click goes to the program', async () => {
  const el = new El('div');
  const t = new Terminal(el, { fontSize: 15 });
  const sent = [];
  t.onData = (u8) => sent.push(new TextDecoder().decode(u8));
  const opened = [];
  const prev = window.open;
  window.open = (u) => { opened.push(u); };
  const x = 10 * 9 + 1, y = 1;
  const click = (mods) => {
    t.canvas.dispatch('mousedown', { button: 0, detail: 1, clientX: x, clientY: y, ...mods });
    window.dispatch('mouseup', { button: 0, clientX: x, clientY: y, ...mods });
  };
  try {
    t.write('see https://example.com/docs. ok\r\n');
    t.write('\x1b[?1000h\x1b[?1006h'); // a program (Claude Code, vim) reports the mouse
    t.canvas.dispatch('mousemove', { clientX: x, clientY: y });
    assert.equal(t.renderer.hover, null, 'no hover without Ctrl: a click goes to the program');
    window.dispatch('keydown', { key: 'Control', ctrlKey: true });
    assert.equal(t.renderer.hover?.url, 'https://example.com/docs', 'pressing Ctrl shows the link');
    assert.equal(t.canvas.style.cursor, 'pointer');
    window.dispatch('keyup', { key: 'Control', ctrlKey: false });
    assert.equal(t.renderer.hover, null, 'releasing Ctrl hides it');
    t.canvas.dispatch('mousemove', { clientX: x, clientY: y, metaKey: true });
    assert.equal(t.renderer.hover?.url, 'https://example.com/docs', 'Cmd works too');

    sent.length = 0;
    click({});
    assert.deepEqual(opened, [], 'a plain click does not open');
    assert.deepEqual(sent, ['\x1b[<0;11;1M', '\x1b[<0;11;1m'], 'a plain click is reported');

    sent.length = 0;
    click({ ctrlKey: true });
    assert.deepEqual(opened, ['https://example.com/docs'], 'Ctrl+click opens');
    assert.deepEqual(sent, [], 'and is not reported');

    click({ metaKey: true });
    assert.deepEqual(opened.length, 2, 'Cmd+click opens');

    sent.length = 0;
    t.canvas.dispatch('mousedown', { button: 0, detail: 1, clientX: 1, clientY: 1, ctrlKey: true });
    window.dispatch('mouseup', { button: 0, clientX: 1, clientY: 1, ctrlKey: true });
    assert.equal(opened.length, 2, 'Ctrl+click on plain text opens nothing');
    assert.equal(sent.length, 2, 'and is reported');
  } finally {
    window.open = prev;
    t.dispose();
  }
});

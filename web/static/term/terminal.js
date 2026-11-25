// Terminal: glues the screen model, the canvas renderer and browser input.
//
//   const t = new Terminal(el, {fontFamily, fontSize, scrollback, theme});
//   t.onData = (u8) => ...; t.onResize = (cols, rows) => ...;
//   t.write(u8 | string);

import { Screen, DEFAULT_THEME, HIDDEN } from './screen.js';
import { CanvasRenderer } from './renderer.js';
import { encodeKey, encodeMouse, encodePaste } from './input.js';
import { safeURL, urlRangeAt } from './links.js';

const DEFAULT_FONT = '"JetBrains Mono", "Fira Code", "Cascadia Code", "SF Mono", Menlo, Consolas, "DejaVu Sans Mono", "Liberation Mono", monospace';
const SYNC_TIMEOUT = 150;
const WORD_CHARS = /[\p{L}\p{N}_\-.\/~:@%+#?=&]/u;

async function inflate(bytes) {
  const ds = new DecompressionStream('deflate');
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Default kitty image decoder: bytes -> ImageBitmap. */
export async function browserImageDecoder(img, bytes, { compressed, format, width, height }) {
  if (compressed) bytes = await inflate(bytes);
  if (format === 100) {
    const bm = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    return { bitmap: bm, width: bm.width, height: bm.height };
  }
  const bpp = format === 24 ? 3 : 4;
  if (bytes.length < width * height * bpp) throw new Error('short image data');
  const rgba = new Uint8ClampedArray(width * height * 4);
  if (bpp === 4) rgba.set(bytes.subarray(0, width * height * 4));
  else {
    for (let i = 0, j = 0; i < width * height; i++, j += 3) {
      rgba[i * 4] = bytes[j]; rgba[i * 4 + 1] = bytes[j + 1]; rgba[i * 4 + 2] = bytes[j + 2]; rgba[i * 4 + 3] = 255;
    }
  }
  const bm = await createImageBitmap(new ImageData(rgba, width, height));
  return { bitmap: bm, width, height };
}

const INPUT_PAD = '  ';

export class Terminal {
  constructor(container, options = {}) {
    this.opts = {
      fontFamily: DEFAULT_FONT, fontSize: 15, scrollback: 5000, copyOnSelect: false, ctrlCopyPaste: false,
      clipboard: true, // OSC 52 from the program may set the clipboard (off for playback)
      mouseReporting: true, // mouse modes the program sets get clicks (off for playback: they select)
      clickOpensLinks: true, // a plain click or a tap opens a link (false: Ctrl/Cmd+click only)
      ...options,
      theme: { ...DEFAULT_THEME, ...(options.theme || {}) },
    };
    this.onData = null;
    this.onResize = null;
    this.onTitle = null;
    this.onBell = null;
    this.container = container;
    if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
    container.style.overflow = 'hidden';

    const s = new Screen(80, 24, { scrollback: this.opts.scrollback, decoder: browserImageDecoder, theme: this.opts.theme });
    this.screen = s;
    this._replaying = false; // write(data, {replies: false}) in progress
    s.onReply = (str) => { if (!this._replaying) this._emit(str); };
    s.onTitle = (t) => this.onTitle && this.onTitle(t);
    s.onBell = () => this.onBell && this.onBell();
    s.onClipboard = (text) => {
      if (this.opts.clipboard && !this._replaying) navigator.clipboard?.writeText(text).catch(() => {});
    };
    s.onImage = () => this._schedule();

    this.renderer = new CanvasRenderer(container, s, { fontFamily: this.opts.fontFamily, fontSize: this.opts.fontSize });
    this.canvas = this.renderer.canvas;

    const ta = document.createElement('textarea');
    ta.setAttribute('autocorrect', 'off');
    ta.setAttribute('autocapitalize', 'off');
    ta.setAttribute('autocomplete', 'off');
    ta.setAttribute('spellcheck', 'false');
    ta.setAttribute('aria-label', 'Terminal input');
    ta.setAttribute('tabindex', '0');
    Object.assign(ta.style, {
      position: 'absolute', left: '0', top: '0', width: '2px', height: '1em', opacity: '0',
      padding: '0', border: '0', margin: '0', resize: 'none', overflow: 'hidden', outline: 'none',
      whiteSpace: 'nowrap', pointerEvents: 'none', color: 'transparent', background: 'transparent', zIndex: '1',
    });
    container.appendChild(ta);
    this.textarea = ta;
    this._resetInput();

    this.utf8 = new TextDecoder('utf-8');
    this.enc = new TextEncoder();
    this.cols = s.cols;
    this.rows = s.rows;
    this._raf = 0;
    this._syncStart = 0;
    this._composing = false;
    this._sel = null; // {anchor, head, mode}
    this._mouseDown = -1;
    this._lastMouseCell = '';
    this._wheelAcc = 0;
    this._disposed = false;
    this._fixed = null;                  // {cols, rows}: draw this grid (shared session, watching)
    // Sticky modifiers for touch screens (an on-screen Ctrl/Alt key): 0 off,
    // 1 for the next key, 2 locked. Assign a shared object to share them.
    this.mods = { ctrl: 0, alt: 0 };
    this.onMods = null;
    // liveIME: send text while the on-screen keyboard is still composing a
    // word (Android holds whole words otherwise), as edits (text and DELs).
    this.liveIME = !!this.opts.liveIME;
    this._comp = null;
    this._font = this.opts.fontSize;     // font size in use (smaller than opts.fontSize when fixed)

    this._bind();
    this._ro = new ResizeObserver(() => this.fit());
    this._ro.observe(container);
    this.fit(true);
    queueMicrotask(() => { if (!this._disposed && this.onResize) this.onResize(this.cols, this.rows); });
    this._schedule();
  }

  // ---- public API --------------------------------------------------------------

  // write(data, {replies: false}) draws data without answering the queries
  // in it (DSR, DA, ...) or setting the clipboard (OSC 52): for replayed
  // output whose queries were answered when they were new.
  write(data, { replies = true } = {}) {
    if (this._disposed) return;
    const str = typeof data === 'string' ? data : this.utf8.decode(data, { stream: true });
    if (!str) return;
    // restore, not clear: a callback (onTitle, onBell) may write mid-replay
    const was = this._replaying;
    this._replaying = !replies;
    try { this.screen.write(str); } finally { this._replaying = was; }
    if (this.screen.viewOffset) { this.screen.viewOffset = 0; this.screen.dirtyAll = true; }
    this._hoverStale = true; // the text under the pointer may have changed
    this._schedule();
  }

  fit(silent = false) {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    if (!w || !h) return;
    this.renderer.resizeCanvas(w, h);
    let cols, rows;
    if (this._fixed) {
      ({ cols, rows } = this._fixed);
      this._fitFont(w, h, cols, rows);
    } else {
      this._setFont(this.opts.fontSize);
      ({ cols, rows } = this.renderer.gridSize(w, h));
    }
    if (cols !== this.screen.cols || rows !== this.screen.rows) {
      this.screen.resize(cols, rows);
      this._clearSelection();
    }
    const changed = cols !== this.cols || rows !== this.rows;
    this.cols = cols; this.rows = rows;
    if (changed && !silent && !this._fixed && this.onResize) this.onResize(cols, rows);
    this._schedule();
  }

  /**
   * Draw a fixed grid (cols x rows) instead of fitting the grid to the
   * container: the font shrinks until it fits (never grows past fontSize).
   * null goes back to fitting. Used while watching a shared session, whose
   * size the controlling device sets. onResize is not called while fixed.
   */
  setFixedSize(size) {
    const next = size && size.cols > 0 && size.rows > 0 ? { cols: size.cols, rows: size.rows } : null;
    if (JSON.stringify(next) === JSON.stringify(this._fixed)) return;
    this._fixed = next;
    this.fit();
  }

  _setFont(px) {
    if (px === this._font) return;
    this._font = px;
    this.renderer.setFont(this.opts.fontFamily, px);
  }

  _fitFont(w, h, cols, rows) {
    const max = this.opts.fontSize;
    // estimate from the current cell size, then step down until it fits
    const cw = this.renderer.s.cellW / this._font, ch = this.renderer.s.cellH / this._font;
    let px = Math.min(max, Math.floor(Math.min(w / (cols * cw), h / (rows * ch)) * 2) / 2 + 0.5);
    px = Math.max(4, px);
    this._setFont(px);
    for (let i = 0; i < 40 && px > 4; i++) {
      const g = this.renderer.gridSize(w, h);
      if (g.cols >= cols && g.rows >= rows) break;
      px = Math.max(4, px - 0.5);
      this._setFont(px);
    }
  }

  focus() { this.textarea.focus({ preventScroll: true }); }
  blur() { this.textarea.blur(); }

  reset() {
    this.screen.fullReset();
    this._clearSelection();
    this._schedule();
  }

  setOptions(o = {}) {
    if (o.fontFamily || o.fontSize) {
      if (o.fontFamily) this.opts.fontFamily = o.fontFamily;
      if (o.fontSize) this.opts.fontSize = o.fontSize;
      this._font = this.opts.fontSize;
      this.renderer.setFont(this.opts.fontFamily, this.opts.fontSize);
      this.fit();
    }
    if (o.theme) {
      this.opts.theme = { ...this.opts.theme, ...o.theme };
      this.screen.setTheme(this.opts.theme);
    }
    if (o.copyOnSelect !== undefined) this.opts.copyOnSelect = o.copyOnSelect;
    if (o.ctrlCopyPaste !== undefined) this.opts.ctrlCopyPaste = o.ctrlCopyPaste;
    if (o.clickOpensLinks !== undefined) this.opts.clickOpensLinks = o.clickOpensLinks;
    this._schedule();
  }

  /** Currently selected text ('' if none). */
  getSelection() {
    const r = this._selRange();
    return r ? this.screen.getText(r.start, r.end) : '';
  }

  dispose() {
    this._disposed = true;
    this._ro.disconnect();
    if (this._raf) cancelAnimationFrame(this._raf);
    for (const [t, ev, fn, opt] of this._listeners) t.removeEventListener(ev, fn, opt);
    this.renderer.dispose();
    this.textarea.remove();
  }

  // ---- internals ---------------------------------------------------------------

  _emit(str) {
    if (this.onData && str) this.onData(this.enc.encode(str));
  }

  _schedule() {
    if (this._raf || this._disposed) return;
    this._raf = requestAnimationFrame(() => { this._raf = 0; this._render(); });
  }

  _render() {
    const s = this.screen;
    if (s.modes.sync) {
      const now = performance.now();
      if (!this._syncStart) this._syncStart = now;
      if (now - this._syncStart < SYNC_TIMEOUT) { this._schedule(); return; }
    }
    this._syncStart = 0;
    if (this._hoverStale) { // once per frame, not per write
      this._hoverStale = false;
      if (this._pointer) this._hover(this._hoverMods || {});
      else if (this.renderer.hover) this._setHover(null);
    }
    this.renderer.selection = this._selRange();
    this.renderer.render(false);
    const b = s.buf;
    const p = this.renderer.cellPos(b.x, b.y);
    this.textarea.style.left = p.x + 'px';
    this.textarea.style.top = p.y + 'px';
    this.textarea.style.height = p.h + 'px';
  }

  _on(target, ev, fn, opt) {
    target.addEventListener(ev, fn, opt);
    (this._listeners ||= []).push([target, ev, fn, opt]);
  }

  _bind() {
    const ta = this.textarea;
    this._on(ta, 'keydown', (e) => this._keydown(e));
    this._on(ta, 'compositionstart', () => { this._composing = true; this._comp = ''; });
    this._on(ta, 'compositionupdate', (e) => {
      if (this.liveIME) this._compTo(e.data || '');
    });
    this._on(ta, 'compositionend', (e) => {
      this._composing = false;
      if (this.liveIME) this._compTo(e.data || '');
      else if (e.data) this._typed(e.data);
      this._comp = null;
      this._resetInput();
    });
    this._on(ta, 'input', (e) => {
      if (this._composing || e.isComposing) return;
      if (e.inputType === 'insertText' || e.inputType === 'insertReplacementText') {
        if (e.data) this._typed(e.data);
      } else if (e.inputType === 'deleteContentBackward') {
        this.pressKey('Backspace');
      } else if (e.inputType === 'deleteWordBackward') {
        this._input('\x17'); // ^W
      } else if (e.inputType === 'insertLineBreak') {
        this.pressKey('Enter');
      }
      this._resetInput();
    });
    this._on(ta, 'paste', (e) => {
      e.preventDefault();
      const text = e.clipboardData ? e.clipboardData.getData('text/plain') : '';
      if (text) this._input(encodePaste(text, this.screen.modes.bracketedPaste));
    });
    this._on(ta, 'copy', (e) => {
      const t = this.getSelection();
      if (!t) return;
      e.preventDefault();
      e.clipboardData.setData('text/plain', t);
    });
    this._on(ta, 'focus', () => {
      this._resetInput();
      this.renderer.focused = true;
      if (this.screen.modes.focus) this._emit('\x1b[I');
      this._schedule();
    });
    this._on(ta, 'blur', () => {
      this.renderer.focused = false;
      if (this.screen.modes.focus) this._emit('\x1b[O');
      this._schedule();
    });

    const c = this.canvas;
    this._on(c, 'mousedown', (e) => this._mousedown(e));
    // link hover: pointer cursor and underline where a click opens a link
    this._on(c, 'mousemove', (e) => {
      this._pointer = { x: e.clientX, y: e.clientY };
      this._hoverMods = { ctrlKey: e.ctrlKey, metaKey: e.metaKey, shiftKey: e.shiftKey, altKey: e.altKey };
      this._hover(this._hoverMods);
    });
    this._on(c, 'mouseleave', () => { this._pointer = null; this._setHover(null); });
    const modKey = (e) => {
      if (e.key !== 'Control' && e.key !== 'Meta' && e.key !== 'Shift' && e.key !== 'Alt') return;
      this._hoverMods = { ctrlKey: e.ctrlKey, metaKey: e.metaKey, shiftKey: e.shiftKey, altKey: e.altKey };
      if (this._pointer) this._hover(this._hoverMods);
    };
    this._on(window, 'keydown', modKey);
    this._on(window, 'keyup', modKey);
    this._on(window, 'mousemove', (e) => this._mousemove(e));
    this._on(window, 'mouseup', (e) => this._mouseup(e));
    this._on(c, 'wheel', (e) => this._wheel(e), { passive: false });
    this._on(c, 'contextmenu', (e) => { if (this._mouseReporting(e)) e.preventDefault(); });
    // touch: a vertical drag scrolls (scrollback, or the app like a wheel),
    // with a fling; a tap focuses (opens the on-screen keyboard)
    this._on(c, 'touchstart', (e) => this._touchstart(e), { passive: true });
    this._on(c, 'touchmove', (e) => this._touchmove(e), { passive: false });
    this._on(c, 'touchend', (e) => this._touchend(e), { passive: false });
    this._on(c, 'touchcancel', () => { this._touch = null; }, { passive: true });
  }

  // On-screen keyboards (Android's in particular) do not send Backspace as a
  // key: they delete text in the textarea, and an empty textarea has nothing
  // to delete, so no event fires at all. Keep a little text before the caret
  // so each delete arrives as an input event (deleteContentBackward).
  _resetInput() {
    const ta = this.textarea;
    if (ta.value === INPUT_PAD && ta.selectionStart === INPUT_PAD.length) return;
    ta.value = INPUT_PAD;
    if (ta.setSelectionRange) ta.setSelectionRange(INPUT_PAD.length, INPUT_PAD.length);
  }

  /**
   * pressKey sends one key as if typed, with the sticky modifiers: a
   * KeyboardEvent key name ('Escape', 'Tab', 'ArrowUp', 'Enter', ...) or a
   * single character. For on-screen key bars.
   */
  pressKey(key) {
    const m = this._takeMods();
    const seq = encodeKey({ key, code: '', ctrlKey: m.ctrl, altKey: m.alt, shiftKey: false, metaKey: false }, this.screen.modes);
    if (seq === null) return;
    if (this._sel) this._clearSelection();
    this._input(seq);
  }

  setMod(name, state) {
    if (!(name in this.mods)) return;
    this.mods[name] = state;
    if (this.onMods) this.onMods(this.mods);
  }

  // _takeMods returns the modifiers for one key; one-shot ones are used up.
  _takeMods() {
    const m = { ctrl: this.mods.ctrl > 0, alt: this.mods.alt > 0 };
    let used = false;
    for (const k of ['ctrl', 'alt']) if (this.mods[k] === 1) { this.mods[k] = 0; used = true; }
    if (used && this.onMods) this.onMods(this.mods);
    return m;
  }

  // _typed: text from the on-screen keyboard, with sticky modifiers applied
  // to each character while they are on.
  _typed(str) {
    if (!this.mods.ctrl && !this.mods.alt) { this._input(str); return; }
    for (const ch of str) {
      if (this.mods.ctrl || this.mods.alt) this.pressKey(ch);
      else this._input(ch);
    }
  }

  // _compTo moves what we sent for the current composition to text (live
  // IME): DEL what changed, then send the new part.
  _compTo(text) {
    const prev = this._comp ?? '';
    let i = 0;
    while (i < prev.length && i < text.length && prev[i] === text[i]) i++;
    const del = [...prev.slice(i)].length;
    if (del) this._input('\x7f'.repeat(del));
    if (text.length > i) this._typed(text.slice(i));
    this._comp = text;
  }

  _input(str) {
    this._snapToBottom();
    this._emit(str);
  }

  _snapToBottom() {
    if (this.screen.viewOffset) { this.screen.viewOffset = 0; this.screen.dirtyAll = true; this._schedule(); }
  }

  _keydown(e) {
    if (e.isComposing || e.keyCode === 229 || this._composing) return;
    const s = this.screen;
    if (e.ctrlKey && e.shiftKey && e.code === 'KeyC') {
      e.preventDefault();
      const t = this.getSelection();
      if (t) navigator.clipboard?.writeText(t).catch(() => {});
      return;
    }
    if (e.ctrlKey && e.shiftKey && e.code === 'KeyV') return; // let the paste event fire
    if (this.opts.ctrlCopyPaste && e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey) {
      // Ctrl+C copies when text is selected (else it is ^C as usual);
      // Ctrl+V pastes (the literal-next ^V is lost; Ctrl+Shift+V also pastes)
      if (e.code === 'KeyC') {
        const t = this.getSelection();
        if (t) {
          e.preventDefault();
          navigator.clipboard?.writeText(t).catch(() => {});
          this._clearSelection();
          return;
        }
      } else if (e.code === 'KeyV') {
        return; // no preventDefault: the browser fires 'paste' on the textarea
      }
    }
    if (e.metaKey && (e.code === 'KeyC' || e.code === 'KeyV')) return; // macOS Cmd+C / Cmd+V
    if (e.shiftKey && !e.ctrlKey && !e.altKey && !s.modes.altScreen) {
      const page = Math.max(1, s.rows - 1);
      let d = 0;
      if (e.key === 'PageUp') d = page; else if (e.key === 'PageDown') d = -page;
      else if (e.key === 'Home') d = s.buf.sbLength; else if (e.key === 'End') d = -s.buf.sbLength;
      if (d) { e.preventDefault(); s.scrollView(d); this._schedule(); return; }
    }
    const altGraph = typeof e.getModifierState === 'function' && e.getModifierState('AltGraph');
    const isMod = ['Control', 'Alt', 'Shift', 'Meta', 'AltGraph'].includes(e.key);
    const sticky = (this.mods.ctrl || this.mods.alt) && !isMod ? this._takeMods() : { ctrl: false, alt: false };
    const seq = encodeKey({
      key: e.key, code: e.code, ctrlKey: (e.ctrlKey || sticky.ctrl) && !altGraph, altKey: (e.altKey || sticky.alt) && !altGraph,
      shiftKey: e.shiftKey, metaKey: e.metaKey, altGraph,
    }, s.modes);
    if (seq === null) return;
    e.preventDefault();
    if (this._sel) this._clearSelection();
    this._input(seq);
  }

  // ---- mouse ---------------------------------------------------------------------

  _mouseReporting(e) { return this.opts.mouseReporting && this.screen.modes.mouse !== 0 && !e.shiftKey; }

  _report(button, cell, o) {
    const seq = encodeMouse(button, cell.col, cell.row, o, this.screen.modes);
    if (seq) this._emit(seq);
  }

  _mods(e) { return { shift: e.shiftKey, alt: e.altKey, ctrl: e.ctrlKey }; }

  _mousedown(e) {
    e.preventDefault();
    this.focus();
    const cell = this.renderer.cellAt(e.clientX, e.clientY);
    // Ctrl/Cmd+click on a link opens it even when the program reports the
    // mouse; other clicks (and Ctrl/Cmd+click elsewhere) go to the program
    const modLink = (e.ctrlKey || e.metaKey) && e.button === 0 && this._mouseReporting(e) &&
      this._linkAt(this._abs(cell)) !== null;
    if (this._mouseReporting(e) && !modLink) {
      if (e.button > 2) return;
      this._mouseDown = e.button;
      this._lastMouseCell = `${cell.col},${cell.row}`;
      this._report(e.button, cell, this._mods(e));
      return;
    }
    if (e.button !== 0) return;
    const pos = this._abs(cell);
    const mode = e.detail >= 3 ? 'line' : e.detail === 2 ? 'word' : 'char';
    // Ctrl/Cmd+click always opens a link; a plain click does too unless
    // clickOpensLinks is off. Shift and Alt clicks only select.
    const plain = this.opts.clickOpensLinks && !e.shiftKey && !e.altKey;
    this._clickStart = { x: e.clientX, y: e.clientY, link: (e.ctrlKey || e.metaKey || plain) ? this._linkAt(pos) : null };
    this._sel = { anchor: pos, head: pos, mode, active: true, moved: mode !== 'char' };
    this._mouseDown = 0;
    this.screen.dirtyAll = true;
    this._schedule();
  }

  _abs(cell) {
    const col = cell.half && cell.col < this.screen.cols ? cell.col + 1 : cell.col;
    return { abs: this.screen.viewTop + cell.row, col: Math.min(col, this.screen.cols), cell: cell.col };
  }

  _mousemove(e) {
    if (this._mouseDown < 0 && !(this.screen.modes.mouse === 1003 && e.target === this.canvas)) return;
    const cell = this.renderer.cellAt(e.clientX, e.clientY);
    if (this._sel && this._sel.active) {
      // autoscroll when dragging past the edges
      if (cell.rawRow < 0) this.screen.scrollView(1);
      else if (cell.rawRow >= this.screen.rows) this.screen.scrollView(-1);
      const pos = this._abs(cell);
      if (pos.abs !== this._sel.head.abs || pos.col !== this._sel.head.col) {
        this._sel.head = pos;
        this._sel.moved = true;
        this.screen.dirtyAll = true;
        this._schedule();
      }
      return;
    }
    const m = this.screen.modes.mouse;
    if (m === 1003 || (m === 1002 && this._mouseDown >= 0)) {
      const key = `${cell.col},${cell.row}`;
      if (key === this._lastMouseCell) return;
      this._lastMouseCell = key;
      this._report(this._mouseDown >= 0 ? this._mouseDown : 3, cell, { ...this._mods(e), motion: true });
    }
  }

  _mouseup(e) {
    if (this._mouseDown < 0) return;
    const cell = this.renderer.cellAt(e.clientX, e.clientY);
    if (this._sel && this._sel.active) {
      this._sel.active = false;
      const cs = this._clickStart;
      if (!this._sel.moved) {
        this._clearSelection();
        const url = cs && safeURL(cs.link);
        if (url) window.open(url, '_blank', 'noopener,noreferrer');
      } else if (this.opts.copyOnSelect) {
        const t = this.getSelection();
        if (t) navigator.clipboard?.writeText(t).catch(() => {});
      }
      this._mouseDown = -1;
      return;
    }
    const m = this.screen.modes.mouse;
    if (m !== 0 && m !== 9) this._report(this._mouseDown, cell, { ...this._mods(e), release: true });
    this._mouseDown = -1;
  }

  _wheel(e) {
    e.preventDefault();
    const s = this.screen;
    let dy = e.deltaY;
    if (e.deltaMode === 1) dy *= this.renderer.ch / this.renderer.dpr;
    else if (e.deltaMode === 2) dy *= s.rows * this.renderer.ch / this.renderer.dpr;
    this._wheelAcc += dy;
    const unit = this.renderer.ch / this.renderer.dpr;
    const lines = Math.trunc(this._wheelAcc / unit);
    if (!lines) return;
    this._wheelAcc -= lines * unit;
    if (this._mouseReporting(e)) {
      const cell = this.renderer.cellAt(e.clientX, e.clientY);
      const n = Math.min(Math.abs(lines), 10);
      for (let i = 0; i < n; i++) this._report(lines < 0 ? 64 : 65, cell, this._mods(e));
      return;
    }
    if (s.modes.altScreen) {
      const key = lines < 0 ? 'A' : 'B';
      const seq = (s.modes.appCursor ? '\x1bO' : '\x1b[') + key;
      const n = Math.min(Math.abs(lines), 30);
      this._emit(seq.repeat(n));
      return;
    }
    s.scrollView(-lines);
    this._schedule();
  }

  _touchstart(e) {
    if (e.touches.length !== 1) { this._touch = null; return; }
    const t = e.touches[0];
    cancelAnimationFrame(this._fling || 0);
    this._fling = 0;
    this._touch = { x0: t.clientX, y0: t.clientY, y: t.clientY, x: t.clientX, moved: false, v: 0, at: performance.now() };
  }

  _touchmove(e) {
    const st = this._touch;
    if (!st || e.touches.length !== 1) return;
    const t = e.touches[0];
    if (!st.moved && Math.abs(t.clientY - st.y0) < 8) return;
    if (!st.moved && Math.abs(t.clientX - st.x0) > Math.abs(t.clientY - st.y0)) { this._touch = null; return; }
    st.moved = true;
    e.preventDefault(); // no page scroll or pull-to-refresh
    const dy = st.y - t.clientY, now = performance.now();
    const dt = Math.max(1, now - st.at);
    st.v = 0.8 * (dy / dt) + 0.2 * st.v; // px per ms, smoothed
    st.y = t.clientY; st.x = t.clientX; st.at = now;
    this._scrollBy(dy, t.clientX, t.clientY);
  }

  _touchend(e) {
    const st = this._touch;
    this._touch = null;
    if (!st) return;
    if (!st.moved) {
      // a tap on a link opens it, without the keyboard popping up. A program
      // that reports the mouse gets the tap instead (as a click).
      if (this.opts.clickOpensLinks && !this._mouseReporting(e)) {
        const url = safeURL(this._linkAt(this._abs(this.renderer.cellAt(st.x0, st.y0))));
        if (url) {
          e.preventDefault(); // no emulated click: it would open the link again
          window.open(url, '_blank', 'noopener,noreferrer');
          return;
        }
      }
      this.focus();
      return;
    }
    e.preventDefault(); // no click/mousedown emulation after a drag
    let v = st.v;
    if (performance.now() - st.at > 80 || Math.abs(v) < 0.3) return;
    let last = performance.now();
    const step = (now) => {
      const dt = now - last; last = now;
      this._scrollBy(v * dt, st.x, st.y);
      v *= Math.pow(0.995, dt);
      this._fling = Math.abs(v) > 0.05 && !this._disposed ? requestAnimationFrame(step) : 0;
    };
    this._fling = requestAnimationFrame(step);
  }

  _scrollBy(dy, clientX, clientY) {
    this._wheel({ deltaY: dy, deltaMode: 0, clientX, clientY, shiftKey: false, ctrlKey: false, altKey: false, preventDefault() {} });
  }

  _linkAt(pos) {
    const r = this._linkRangeAt(pos);
    return r ? r.url : null;
  }

  // _linkRangeAt: the link under pos, as {url, start:{abs,col}, end:{abs,col}}
  // (end exclusive, the shape of a selection range), or null.
  _linkRangeAt(pos) {
    const l = this.screen.lineAt(pos.abs);
    if (!l || pos.cell >= l.cols) return null;
    const id = l.ln[pos.cell];
    // an OSC 8 target that may not be opened, or one already forgotten,
    // falls back to a plain URL in the text under the click
    const url = id ? safeURL(this.screen.links.get(id)) : null;
    if (url) return { url, ...this._osc8Extent(pos, id) };
    return this._plainLinkAt(pos);
  }

  // _osc8Extent: the run of cells around pos carrying OSC 8 link id, across
  // soft wraps.
  _osc8Extent(pos, id) {
    const s = this.screen;
    let abs = pos.abs, col = pos.cell;
    for (let n = 0; n < 4096; n++) { // walk back
      const l = s.lineAt(abs);
      if (col > 0 && l.ln[col - 1] === id) { col--; continue; }
      const prev = col === 0 && s.lineAt(abs - 1);
      if (prev && prev.wrapped && prev.ln[prev.cols - 1] === id) { abs--; col = prev.cols - 1; continue; }
      break;
    }
    const start = { abs, col };
    abs = pos.abs; col = pos.cell;
    for (let n = 0; n < 4096; n++) { // walk forward
      const l = s.lineAt(abs);
      if (col + 1 < l.cols && l.ln[col + 1] === id) { col++; continue; }
      const next = col + 1 >= l.cols && l.wrapped && s.lineAt(abs + 1);
      if (next && next.ln[0] === id) { abs++; col = 0; continue; }
      break;
    }
    return { start, end: { abs, col: col + 1 } };
  }

  // _plainLinkAt: a bare http(s) URL under pos, also when it wraps across
  // lines (soft wraps only), with its cell range.
  _plainLinkAt(pos) {
    const s = this.screen;
    let start = pos.abs;
    for (let n = 0; n < 32; n++) {
      const prev = s.lineAt(start - 1);
      if (!prev || !prev.wrapped) break;
      start--;
    }
    let text = '', at = -1;
    const cells = []; // per character cell: {abs, col, i (index in text), w}
    for (let abs = start, n = 0; n < 64; abs++, n++) {
      const l = s.lineAt(abs);
      if (!l) break;
      for (let c = 0; c < l.cols; c++) {
        if (l.wd[c] === 0) continue; // second half of a wide character
        if (abs === pos.abs && c <= pos.cell) at = text.length;
        cells.push({ abs, col: c, i: text.length, w: l.wd[c] });
        text += l.fl[c] & HIDDEN ? ' ' : l.ch[c]; // concealed (SGR 8) text is not shown, so not linked
      }
      if (!l.wrapped || abs >= pos.abs + 32) break;
    }
    const r = at < 0 ? null : urlRangeAt(text, at);
    if (!r) return null;
    const inside = cells.filter((c) => c.i >= r.start && c.i < r.end);
    const a = inside[0], b = inside[inside.length - 1];
    return { url: r.url, start: { abs: a.abs, col: a.col }, end: { abs: b.abs, col: b.col + b.w } };
  }

  // ---- link hover ------------------------------------------------------------------

  // _hover underlines the link under the pointer and shows a pointer cursor,
  // when a click would open it: a plain click (clickOpensLinks, no mouse
  // reporting) or Ctrl/Cmd+click (always). e: a mouse or key event with
  // the modifier state; the pointer position is the last one seen.
  _hover(e) {
    const p = this._pointer;
    let range = null;
    if (p && this._mouseDown < 0) {
      const mod = e.ctrlKey || e.metaKey;
      const plain = this.opts.clickOpensLinks && !e.shiftKey && !e.altKey && !this._mouseReporting(e);
      if (mod || plain) {
        const cell = this.renderer.cellAt(p.x, p.y);
        if (cell.rawRow >= 0 && cell.rawRow < this.screen.rows) {
          range = this._linkRangeAt(this._abs(cell));
        }
      }
    }
    this._setHover(range);
  }

  _setHover(range) {
    const old = this.renderer.hover;
    const same = (a, b) => a === b || (a && b && a.start.abs === b.start.abs && a.start.col === b.start.col &&
      a.end.abs === b.end.abs && a.end.col === b.end.col);
    if (same(old, range)) return;
    this.renderer.hover = range;
    this.canvas.style.cursor = range ? 'pointer' : '';
    this.screen.dirtyAll = true;
    this._schedule();
  }

  // ---- selection -------------------------------------------------------------------

  _clearSelection() {
    if (this._sel) { this._sel = null; this.screen.dirtyAll = true; this._schedule(); }
  }

  _selRange() {
    const sel = this._sel;
    if (!sel || !sel.moved) return null;
    let a = sel.anchor, b = sel.head;
    if (a.abs > b.abs || (a.abs === b.abs && a.col > b.col)) [a, b] = [b, a];
    let start = { abs: a.abs, col: a.col }, end = { abs: b.abs, col: b.col };
    if (sel.mode === 'word') {
      start = this._wordEdge(a.abs, Math.min(a.cell ?? a.col, this.screen.cols - 1), -1);
      end = this._wordEdge(b.abs, Math.min(b.cell ?? b.col, this.screen.cols - 1), 1);
    } else if (sel.mode === 'line') {
      start = { abs: a.abs, col: 0 };
      end = { abs: b.abs, col: this.screen.cols };
    }
    if (start.abs === end.abs && start.col >= end.col) return null;
    return { start, end };
  }

  _wordEdge(abs, col, dir) {
    const l = this.screen.lineAt(abs);
    if (!l) return { abs, col: dir < 0 ? 0 : this.screen.cols };
    const isWord = (i) => i >= 0 && i < l.cols && (l.wd[i] === 0 || WORD_CHARS.test(l.ch[i] || ' '));
    if (!isWord(col)) return { abs, col: dir < 0 ? col : col + 1 };
    let i = col;
    if (dir < 0) { while (i > 0 && isWord(i - 1)) i--; return { abs, col: i }; }
    while (i < l.cols - 1 && isWord(i + 1)) i++;
    return { abs, col: i + 1 };
  }
}

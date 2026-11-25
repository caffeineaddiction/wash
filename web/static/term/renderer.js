// Canvas 2D renderer. Draws only rows that changed (by line identity, the
// line's dirty flag, cursor moves) once per animation frame. Everything is
// drawn in device pixels with integer cell sizes so text and box drawing
// stay crisp. A WebGL/pixi renderer can replace this class as long as it
// implements the same small interface (setFont, setTheme, resizeCanvas,
// gridSize, cellAt, render, dispose, selection, focused).

import { BOLD, DIM, ITALIC, INVERSE, HIDDEN, STRIKE, OVERLINE, UL_SHIFT, RGB } from './screen.js';
import { drawBox, isBoxChar } from './boxdraw.js';

function hex(rgb) { return '#' + (rgb & 0xffffff).toString(16).padStart(6, '0'); }

export class CanvasRenderer {
  constructor(container, screen, { fontFamily, fontSize }) {
    this.s = screen;
    this.canvas = document.createElement('canvas');
    Object.assign(this.canvas.style, { position: 'absolute', left: '0', top: '0', display: 'block', cursor: 'text' });
    container.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d', { alpha: false });
    this.fontFamily = fontFamily;
    this.fontSize = fontSize;
    this.rowLines = [];
    this.selection = null; // {start:{abs,col}, end:{abs,col}} end exclusive
    this.hover = null;     // link under the pointer, same shape: underlined
    this.focused = false;
    this.prevCursor = '';
    this.prevCursorRow = -1;
    this.cssW = 0; this.cssH = 0;
    this.measure();
  }

  setFont(family, size) {
    if (family) this.fontFamily = family;
    if (size) this.fontSize = size;
    this.measure();
    this.s.dirtyAll = true;
  }

  measure() {
    const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    this.dpr = dpr;
    const fs = Math.max(4, Math.round(this.fontSize * dpr));
    this.fs = fs;
    const ctx = this.ctx;
    ctx.font = `${fs}px ${this.fontFamily}`;
    const m = ctx.measureText('M');
    const asc = m.fontBoundingBoxAscent ?? m.actualBoundingBoxAscent ?? fs * 0.8;
    const desc = m.fontBoundingBoxDescent ?? m.actualBoundingBoxDescent ?? fs * 0.2;
    this.cw = Math.max(1, Math.round(m.width));
    this.ch = Math.max(1, Math.ceil(asc + desc));
    this.baseline = Math.round(asc + (this.ch - asc - desc) / 2);
    this.lw = Math.max(1, Math.round(fs / 15));
    this.s.cellW = this.cw / dpr;
    this.s.cellH = this.ch / dpr;
    this.fonts = [0, 1, 2, 3].map((v) => `${v & 2 ? 'italic ' : ''}${v & 1 ? 'bold ' : ''}${fs}px ${this.fontFamily}`);
  }

  /** Grid that fits a CSS-pixel area. */
  gridSize(w, h) {
    return {
      cols: Math.max(2, Math.floor((w * this.dpr) / this.cw)),
      rows: Math.max(1, Math.floor((h * this.dpr) / this.ch)),
    };
  }

  resizeCanvas(w, h) {
    const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    if (dpr !== this.dpr) this.measure();
    if (w === this.cssW && h === this.cssH && this.canvas.width === Math.round(w * this.dpr)) return;
    this.cssW = w; this.cssH = h;
    this.canvas.width = Math.max(1, Math.round(w * this.dpr));
    this.canvas.height = Math.max(1, Math.round(h * this.dpr));
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';
    this.s.dirtyAll = true;
  }

  /** Cell under client coordinates (may be outside the grid). */
  cellAt(clientX, clientY) {
    const r = this.canvas.getBoundingClientRect();
    const px = (clientX - r.left) * this.dpr, py = (clientY - r.top) * this.dpr;
    return {
      col: Math.max(0, Math.min(this.s.cols - 1, Math.floor(px / this.cw))),
      row: Math.max(0, Math.min(this.s.rows - 1, Math.floor(py / this.ch))),
      rawRow: Math.floor(py / this.ch),
      half: (px / this.cw) % 1 >= 0.5,
    };
  }

  /** CSS pixel position of a cell (for the IME textarea). */
  cellPos(col, row) { return { x: (col * this.cw) / this.dpr, y: (row * this.ch) / this.dpr, h: this.ch / this.dpr }; }

  _color(c, fg) {
    const s = this.s;
    if (c === 0) {
      const rev = s.modes.reverse;
      return (fg !== rev) ? s.fgColor : s.bgColor;
    }
    if (c >= RGB) return c & 0xffffff;
    return s.palette[c & 255];
  }

  _selected(abs, col) {
    const sel = this.selection;
    if (!sel) return false;
    const { start, end } = sel;
    if (abs < start.abs || abs > end.abs) return false;
    if (abs === start.abs && col < start.col) return false;
    if (abs === end.abs && col >= end.col) return false;
    return true;
  }

  render(force = false) {
    const s = this.s;
    const ctx = this.ctx;
    const rows = s.rows;
    const all = force || s.dirtyAll;
    s.dirtyAll = false;
    const top = s.viewTop;
    const b = s.buf;
    const curRow = s.modes.cursorVisible && s.viewOffset === 0 ? b.y : -1;
    const curKey = `${curRow},${b.x},${this.focused},${s.cursorStyle}`;
    const curMoved = curKey !== this.prevCursor;
    if (all) {
      ctx.fillStyle = hex(s.modes.reverse ? s.fgColor : s.bgColor);
      ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
      this.rowLines = [];
    }
    const pls = b.placements.length
      ? b.placements.filter((p) => p.img.bitmap && p.abs < top + rows && p.abs + p.rows > top)
      : null;
    for (let r = 0; r < rows; r++) {
      const line = s.lineAt(top + r);
      const need = all || line !== this.rowLines[r] || (line && line.dirty) ||
        (curMoved && (r === curRow || r === this.prevCursorRow));
      if (!need) continue;
      this.rowLines[r] = line;
      this._drawRow(r, line, top + r, pls, r === curRow ? b.x : -1);
      if (line) line.dirty = false;
    }
    this.prevCursor = curKey;
    this.prevCursorRow = curRow;
  }

  _drawImages(pls, r, abs, under) {
    if (!pls) return;
    const ctx = this.ctx, cw = this.cw, ch = this.ch, dpr = this.dpr;
    for (const p of pls) {
      if ((p.z < 0) !== under) continue;
      if (abs < p.abs || abs >= p.abs + p.rows) continue;
      const dx = p.col * cw + p.ox * dpr;
      const dy = (r - (abs - p.abs)) * ch + p.oy * dpr;
      if (p.sw <= 0 || p.sh <= 0) continue;
      try {
        ctx.drawImage(p.img.bitmap, p.sx, p.sy, p.sw, p.sh, dx, dy, p.dw * dpr, p.dh * dpr);
      } catch { /* bitmap closed */ }
    }
  }

  _drawRow(r, line, abs, pls, curX) {
    const s = this.s, ctx = this.ctx, cw = this.cw, ch = this.ch;
    const y0 = r * ch;
    const W = this.canvas.width;
    const defBg = s.modes.reverse ? s.fgColor : s.bgColor;
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, y0, W, ch);
    ctx.clip();
    ctx.fillStyle = hex(defBg);
    ctx.fillRect(0, y0, W, ch);
    if (!line) { ctx.restore(); return; }
    const n = Math.min(line.cols, s.cols);

    // backgrounds
    let runStart = 0, runColor = -1;
    for (let x = 0; x <= n; x++) {
      let c = -2;
      if (x < n) {
        const fl = line.fl[x];
        c = fl & INVERSE ? this._color(line.fg[x], true) : this._color(line.bg[x], false);
      }
      if (c !== runColor) {
        if (runColor >= 0 && runColor !== defBg) {
          ctx.fillStyle = hex(runColor);
          ctx.fillRect(runStart * cw, y0, (x - runStart) * cw, ch);
        }
        runStart = x; runColor = c;
      }
    }
    // selection
    if (this.selection && abs >= this.selection.start.abs && abs <= this.selection.end.abs) {
      const st = abs === this.selection.start.abs ? this.selection.start.col : 0;
      const en = abs === this.selection.end.abs ? this.selection.end.col : n;
      if (en > st) {
        ctx.fillStyle = s.theme.selection || 'rgba(120,150,200,0.35)';
        ctx.fillRect(st * cw, y0, (en - st) * cw, ch);
      }
    }
    this._drawImages(pls, r, abs, true);

    // text
    let font = -1, color = -1, alpha = 1;
    const by = y0 + this.baseline;
    ctx.textBaseline = 'alphabetic';
    for (let x = 0; x < n; x++) {
      const w = line.wd[x];
      if (w === 0) continue;
      const fl = line.fl[x];
      const t = line.ch[x];
      const ul = (fl >> UL_SHIFT) & 7;
      const hasDeco = ul || (fl & (STRIKE | OVERLINE));
      if ((t === ' ' || t === '') && !hasDeco) continue;
      if (fl & HIDDEN) continue;
      const fg = fl & INVERSE ? this._color(line.bg[x], false) : this._color(line.fg[x], true);
      if (fg !== color) { ctx.fillStyle = hex(fg); color = fg; }
      const a = fl & DIM ? 0.55 : 1;
      if (a !== alpha) { ctx.globalAlpha = a; alpha = a; }
      const px = x * cw;
      if (t !== ' ' && t !== '') {
        const cp = t.codePointAt(0);
        if (!(t.length === 1 && isBoxChar(cp) && drawBox(ctx, cp, px, y0, cw * w, ch, this.lw))) {
          const f = (fl & BOLD ? 1 : 0) | (fl & ITALIC ? 2 : 0);
          if (f !== font) { ctx.font = this.fonts[f]; font = f; }
          ctx.fillText(t, px, by);
        }
      }
      if (hasDeco) this._deco(line, x, px, y0, cw * w, ul, fl, fg);
    }
    if (alpha !== 1) ctx.globalAlpha = 1;
    // the link under the pointer (terminal sets hover)
    const hv = this.hover;
    if (hv && abs >= hv.start.abs && abs <= hv.end.abs) {
      const st = abs === hv.start.abs ? hv.start.col : 0;
      const en = abs === hv.end.abs ? hv.end.col : n;
      if (en > st) {
        ctx.fillStyle = hex(s.modes.reverse ? s.bgColor : s.fgColor);
        ctx.fillRect(st * cw, Math.min(y0 + ch - this.lw, y0 + this.baseline + this.lw + 1), (en - st) * cw, this.lw);
      }
    }
    this._drawImages(pls, r, abs, false);
    if (curX >= 0) this._cursor(line, Math.min(curX, n - 1), y0);
    ctx.restore();
  }

  _deco(line, x, px, y0, w, ul, fl, fg) {
    const ctx = this.ctx, lw = this.lw, ch = this.ch;
    const uc = line.uc[x];
    if (ul) {
      if (uc) ctx.fillStyle = hex(this._color(uc, true));
      const uy = Math.min(y0 + ch - lw, y0 + this.baseline + lw + 1);
      if (ul === 2) {
        ctx.fillRect(px, uy - lw, w, lw);
        ctx.fillRect(px, Math.min(y0 + ch - lw, uy + lw), w, lw);
      } else if (ul === 3) {
        ctx.save();
        ctx.strokeStyle = ctx.fillStyle;
        ctx.lineWidth = lw;
        ctx.beginPath();
        const amp = Math.max(1, lw);
        for (let i = 0; i <= w; i += 2) {
          const yy = uy + Math.sin((i / w) * Math.PI * 2) * amp;
          if (i === 0) ctx.moveTo(px + i, yy); else ctx.lineTo(px + i, yy);
        }
        ctx.stroke();
        ctx.restore();
      } else if (ul === 4 || ul === 5) {
        const step = ul === 4 ? lw * 2 : lw * 6;
        for (let i = 0; i < w; i += step * 2) ctx.fillRect(px + i, uy, Math.min(step, w - i), lw);
      } else {
        ctx.fillRect(px, uy, w, lw);
      }
      if (uc) ctx.fillStyle = hex(fg);
    }
    if (fl & STRIKE) ctx.fillRect(px, y0 + Math.round(ch / 2) - Math.floor(lw / 2), w, lw);
    if (fl & OVERLINE) ctx.fillRect(px, y0, w, lw);
  }

  _cursor(line, x, y0) {
    const s = this.s, ctx = this.ctx, cw = this.cw, ch = this.ch, lw = this.lw;
    if (x < 0) return;
    const w = line.wd[x] === 2 ? cw * 2 : cw;
    const px = x * cw;
    const style = s.cursorStyle;
    ctx.globalAlpha = 1;
    ctx.fillStyle = hex(s.cursorColor);
    if (!this.focused) {
      ctx.strokeStyle = hex(s.cursorColor);
      ctx.lineWidth = lw;
      ctx.strokeRect(px + lw / 2, y0 + lw / 2, w - lw, ch - lw);
      return;
    }
    if (style === 3 || style === 4) { ctx.fillRect(px, y0 + ch - lw * 2, w, lw * 2); return; }
    if (style === 5 || style === 6) { ctx.fillRect(px, y0, lw * 2, ch); return; }
    ctx.fillRect(px, y0, w, ch);
    const t = line.ch[x];
    if (t && t !== ' ' && !(line.fl[x] & HIDDEN)) {
      const fl = line.fl[x];
      ctx.fillStyle = hex(s.modes.reverse ? s.fgColor : s.bgColor);
      const cp = t.codePointAt(0);
      if (!(t.length === 1 && isBoxChar(cp) && drawBox(ctx, cp, px, y0, w, ch, lw))) {
        ctx.font = this.fonts[(fl & BOLD ? 1 : 0) | (fl & ITALIC ? 2 : 0)];
        ctx.fillText(t, px, y0 + this.baseline);
      }
    }
  }

  dispose() { this.canvas.remove(); }
}

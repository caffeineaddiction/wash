// Entry point for embedding the terminal. Copy the whole term/ directory:
// plain ES modules, no dependencies, no build step.
//
//   import { Terminal } from './term/index.js';
//   const t = new Terminal(el, {fontFamily, fontSize, scrollback, theme});
//   t.onData = (u8) => ...; t.onResize = (cols, rows) => ...;
//   t.write(u8 | string);

export { Terminal, browserImageDecoder } from './terminal.js';
export { DEFAULT_THEME, parseColor } from './screen.js';

// Same value as VERSION in ../wosh.js.
export const VERSION = '0.1.0';

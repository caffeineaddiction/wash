// Links in terminal output: which ones may be opened.

// safeURL returns the URL to open, or null: only http: and https: links are
// opened. Terminal output is untrusted (a `cat` of a hostile file), and a
// javascript: or data: URL would run in the page's origin.
export function safeURL(s) {
  if (typeof s !== 'string' || !s) return null;
  let u;
  try { u = new URL(s); } catch { return null; }
  return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
}

// Box drawing and block elements (U+2500-U+259F) frame text in TUIs and are
// never part of a URL.
const URL_RE = /\bhttps?:\/\/[^\s<>"'`\x00-\x1f\x7f\u2500-\u259f]+/gi;
const TRAIL = '.,;:!?*…。、，’”';
const PAIRS = { ')': '(', ']': '[', '}': '{', '）': '（', '」': '「', '』': '『', '】': '【' };

// trimURL drops trailing punctuation that belongs to the sentence, keeping
// a closing bracket that matches one inside the URL (wiki links). Linear:
// the brackets are counted once, not once per trimmed character.
function trimURL(s) {
  const n = {};
  for (const c of s) n[c] = (n[c] || 0) + 1;
  let end = s.length;
  while (end > 0) {
    const c = s[end - 1];
    if (TRAIL.includes(c)) { end--; continue; }
    const open = PAIRS[c];
    if (open && (n[open] || 0) < n[c]) { n[c]--; end--; continue; }
    break;
  }
  return s.slice(0, end);
}

// urlRangeAt finds a plain http(s) URL in text that covers index i:
// {url, start, end} (end exclusive, indexes into text), or null.
export function urlRangeAt(text, i) {
  for (const m of text.matchAll(URL_RE)) {
    const s = trimURL(m[0]);
    if (i >= m.index && i < m.index + s.length) {
      const url = safeURL(s);
      return url ? { url, start: m.index, end: m.index + s.length } : null;
    }
    if (m.index > i) break;
  }
  return null;
}

// urlAt finds a plain http(s) URL in text that covers index i, or null.
export function urlAt(text, i) {
  const r = urlRangeAt(text, i);
  return r ? r.url : null;
}

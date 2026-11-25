import { test } from 'node:test';
import assert from 'node:assert/strict';
import { safeURL, urlAt, urlRangeAt } from '../../static/term/links.js';

test('safeURL opens only http and https', () => {
  assert.equal(safeURL('https://example.com/a?b=1#c'), 'https://example.com/a?b=1#c');
  assert.equal(safeURL('http://localhost:8080'), 'http://localhost:8080/');
  assert.equal(safeURL('HTTPS://EXAMPLE.COM'), 'https://example.com/');
  for (const bad of ['javascript:alert(1)', 'JavaScript:alert(1)', ' javascript:alert(1)', 'data:text/html,<script>1</script>',
    'file:///etc/passwd', 'vbscript:x', 'blob:https://x/1', 'ftp://example.com', '//example.com', 'example.com', '', null, undefined]) {
    assert.equal(safeURL(bad), null, String(bad));
  }
});

test('urlAt finds plain URLs and drops sentence punctuation', () => {
  const t = 'see https://example.com/a_(b) and (http://x.io/p?q=1).';
  assert.equal(urlAt(t, 4), 'https://example.com/a_(b)');
  assert.equal(urlAt(t, 28), 'https://example.com/a_(b)', 'last char of the URL');
  assert.equal(urlAt(t, 29), null, 'the space after it');
  assert.equal(urlAt(t, t.indexOf('x.io')), 'http://x.io/p?q=1', 'the closing paren and period are not part of it');
  assert.equal(urlAt(t, 1), null);
  assert.equal(urlAt('go to javascript:alert(1)', 8), null, 'only http(s) is detected');
  assert.equal(urlAt('"https://a.b/c",', 3), 'https://a.b/c');
});

test('urlAt stops at box drawing and drops trailing Unicode punctuation', () => {
  assert.equal(urlAt('│https://example.com/a│', 3), 'https://example.com/a');
  assert.equal(urlAt('見て https://example.com/a。', 5), 'https://example.com/a');
  assert.equal(urlAt('‘https://example.com/a’…', 3), 'https://example.com/a');
  assert.equal(urlAt('（https://example.com/a）', 3), 'https://example.com/a');
});

test('urlAt trims a long run of closing brackets in linear time', () => {
  const s = 'https://x.io/' + ')'.repeat(50000);
  const t0 = performance.now();
  assert.equal(urlAt(s, 3), 'https://x.io/');
  assert.ok(performance.now() - t0 < 2000, 'not quadratic');
});

test('urlRangeAt gives the trimmed URL and its index range', () => {
  const t = 'go (https://a.b/c_(d)). now';
  assert.deepEqual(urlRangeAt(t, 6), { url: 'https://a.b/c_(d)', start: 4, end: 21 });
  assert.equal(urlRangeAt(t, 21), null, 'the closing paren after it');
  assert.equal(urlRangeAt('javascript:x', 2), null);
});

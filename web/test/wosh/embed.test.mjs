// Embedding the browser client without washd: WoshSession with a signal
// function, and the files an embedder copies (wosh.js, term/).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { WoshSession, VERSION } from '../../static/wosh.js';
import * as term from '../../static/term/index.js';

const staticDir = fileURLToPath(new URL('../../static/', import.meta.url));

test('signal option: offers go to the embedder, with cid and size', async () => {
  const offers = [];
  const termStub = { cols: 100, rows: 30, write() {} };
  const ws = new WoshSession(null, 'abc', termStub, {
    cid: 'tab9',
    signal: async (o) => { offers.push(o); return 'ANSWER-SDP'; },
  });
  assert.equal(ws.mode, 'webrtc', 'no washd: no bridge');
  assert.deepEqual(ws.iceConfig(), { ice: [], relay: false }, 'host candidates only by default');
  const sdp = await ws.signal('OFFER-SDP');
  assert.equal(sdp, 'ANSWER-SDP');
  // join is what the daemon reads; ice and relay so it uses the same servers
  assert.deepEqual(offers, [{ sdp: 'OFFER-SDP', cols: 100, rows: 30, rx_out: 0, cid: 'tab9', take: false, join: true, ice: [], relay: false }]);
  ws.take = true;
  await ws.signal('OFFER-SDP');
  assert.equal(offers[1].take, true);
  assert.equal(offers[1].join, false);
});

test('signal option: embedder ICE servers win, and a "gone" error ends the session', async () => {
  const ice = [{ urls: ['turn:example.invalid'], username: 'u', credential: 'p' }];
  let exit = null;
  const ws = new WoshSession(null, 'abc', { write() {} }, {
    ice, relay: true,
    signal: async () => { throw new Error('session gone'); },
    onExit: (code, why) => { exit = why; },
  });
  assert.deepEqual(ws.iceConfig(), { ice, relay: true });
  assert.equal(typeof ws.relay, 'function', 'the relay option must not hide relay() (chained hops)');
  ws.open = async () => { await ws.signal('x'); };
  await ws.connect();
  assert.equal(exit, 'session gone');
});

test('embedder ICE servers win over washd\'s, with their own relay flag', () => {
  const ice = [{ urls: ['stun:example.invalid'] }];
  const mgr = { cid: 'tab1', hello: { ice: [{ urls: ['turn:washd.invalid'] }], relay: true } };
  const term = { write() {} };
  assert.deepEqual(new WoshSession(mgr, 'abc', term, { ice }).iceConfig(), { ice, relay: false });
  assert.deepEqual(new WoshSession(mgr, 'abc', term).iceConfig(), { ice: mgr.hello.ice, relay: true });
});

test('embedder ICE urls given as a string go to the daemon as a list', async () => {
  const offers = [];
  const ws = new WoshSession(null, 'abc', { write() {} }, {
    ice: [{ urls: 'stun:example.invalid' }],
    signal: async (o) => { offers.push(o); return 'A'; },
  });
  await ws.signal('x');
  assert.deepEqual(offers[0].ice, [{ urls: ['stun:example.invalid'] }]);
});

test('signal option: a non-Error rejection or no answer still fails cleanly', async () => {
  let exit = null;
  const ws = new WoshSession(null, 'abc', { write() {} }, {
    signal: async () => { throw 'session gone'; }, // eslint-disable-line no-throw-literal
    onExit: (code, why) => { exit = why; },
  });
  ws.open = async () => { await ws.signal('x'); };
  await ws.connect();
  assert.equal(exit, 'session gone');

  for (const bad of [() => Promise.reject(), async () => undefined, async () => ({ sdp: 'X' })]) {
    const w = new WoshSession(null, 'abc', { write() {} }, { signal: bad });
    await assert.rejects(w.signal('x'), (e) => e instanceof Error && typeof e.message === 'string');
  }
});

test('close() while connecting drops the link that came up', async () => {
  let closed = 0;
  const ws = new WoshSession(null, 'abc', { write() {} }, { signal: async () => 'x' });
  ws.open = async () => { ws.close(); return { kind: 'webrtc', send() {}, close() { closed++; } }; };
  await ws.connect();
  assert.equal(closed, 1);
  assert.equal(ws.tr, null);
  assert.equal(ws.pingTimer, null);
});

test('an answer that arrives after close() is refused, with no retry', async () => {
  const states = [];
  let offers = 0;
  const ws = new WoshSession(null, 'abc', { write() {} }, {
    signal: async () => { offers++; ws.close(); return 'A'; }, // e.g. the pane was hidden mid-offer
    onState: (s) => states.push(s.state),
  });
  await assert.rejects(ws.signal('x'), /closed while connecting/);
  ws.closed = false;
  ws.open = async () => { await ws.signal('x'); throw new Error('unreachable'); };
  await ws.connect();
  assert.equal(offers, 2);
  assert.deepEqual(states, ['connecting'], 'no "down" state and no retry once closed');
});

test('a session needs a manager or a signal function', () => {
  assert.throws(() => new WoshSession(null, 'abc', { write() {} }), /signal/);
  const ac = { aborted: false }; // e.g. an AbortSignal passed as `signal`
  assert.throws(() => new WoshSession(null, 'abc', { write() {} }, { signal: ac }), /signal must be a function/);
});

test('one version for wosh.js and term/', () => {
  assert.match(VERSION, /^\d+\.\d+\.\d+$/);
  assert.equal(term.VERSION, VERSION);
  assert.equal(typeof term.Terminal, 'function');
});

test('vendorable files only import each other (no build step)', () => {
  const files = ['wosh.js', ...readdirSync(staticDir + 'term').filter((f) => f.endsWith('.js')).map((f) => 'term/' + f)];
  for (const f of files) {
    const src = readFileSync(staticDir + f, 'utf8');
    // import/export ... from '...' (also over several lines), and import '...'
    const specs = [
      ...src.matchAll(/(?:^|\n)\s*(?:import|export)\b[^;'"]*?\bfrom\s*['"]([^'"]+)['"]/g),
      ...src.matchAll(/(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g),
    ];
    for (const m of specs) {
      const spec = m[1];
      assert.ok(spec.startsWith('./') || spec.startsWith('../'), `${f} imports ${spec}`);
      if (f.startsWith('term/')) assert.ok(spec.startsWith('./'), `${f} reaches outside term/: ${spec}`);
    }
    assert.doesNotMatch(src, /\bimport\s*\(/, `${f} uses a dynamic import`);
  }
});

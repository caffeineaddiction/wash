// Ring replay: output below the daemon's info "out" offset is drawn without
// answering the terminal queries in it (they were answered when new).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WoshSession, F } from '../../static/wosh.js';

const enc = new TextEncoder();
const control = (o) => { const j = enc.encode(JSON.stringify(o)); const b = new Uint8Array(1 + j.length); b[0] = F.CONTROL; b.set(j, 1); return b; };
const output = (off, s) => {
  const d = enc.encode(s); const b = new Uint8Array(9 + d.length);
  b[0] = F.OUTPUT; new DataView(b.buffer).setBigUint64(1, BigInt(off)); b.set(d, 9);
  return b;
};

async function session() {
  const writes = [];
  const term = { cols: 80, rows: 24, write(s, o = {}) { writes.push([new TextDecoder().decode(s), o.replies !== false]); } };
  const ws = new WoshSession({ cid: 'tab1', hello: {} }, 'S', term);
  ws.open = async () => ({ kind: 'webrtc', send() {}, close() {} });
  await ws.connect();
  ws.stopPing();
  return { ws, writes };
}

test('a fresh tab replays old queries quietly, then answers new ones', async () => {
  const { ws, writes } = await session();
  ws.frame(control({ op: 'info', token: 't', out: 12 }));
  ws.frame(output(0, 'old\x1b[5nold!')); // 12 bytes, all replay
  ws.frame(output(12, 'new\x1b[5n'));
  assert.deepEqual(writes, [['old\x1b[5nold!', false], ['new\x1b[5n', true]]);
});

test('a frame that spans the replay end is split at it', async () => {
  const { ws, writes } = await session();
  ws.frame(control({ op: 'info', out: 4 }));
  ws.frame(output(0, 'abcdefgh'));
  assert.deepEqual(writes, [['abcd', false], ['efgh', true]]);
});

test('an old daemon (no out) or a resume past the end: everything answers', async () => {
  const { ws, writes } = await session();
  ws.frame(control({ op: 'info', token: 't' }));
  ws.frame(output(0, 'x\x1b[5n'));
  assert.deepEqual(writes, [['x\x1b[5n', true]]);

  ws.linkDown = () => {}; // reconnect by hand
  await ws.connect();
  ws.stopPing();
  ws.frame(control({ op: 'info', out: 5 })); // resumed at rx_out 5: nothing to replay
  ws.frame(output(5, 'y'));
  assert.deepEqual(writes.at(-1), ['y', true]);
});

test('a resume answers output made while the link was down', async () => {
  const { ws, writes } = await session();
  ws.frame(control({ op: 'info', out: 8 }));
  ws.frame(output(0, 'abcd')); // the link drops halfway through the replay
  ws.linkDown = () => {};
  await ws.connect();
  ws.stopPing();
  // resumed at rx_out 4; 8..12 is a query the program sent while we were away
  ws.frame(control({ op: 'info', out: 12 }));
  ws.frame(output(4, 'efgh\x1b[5nxyz'));
  assert.deepEqual(writes, [['abcd', false], ['efgh', false], ['\x1b[5nxyz', true]]);
});

test('a link that drops before any output: the next link\'s info sets the boundary', async () => {
  const { ws, writes } = await session();
  ws.frame(control({ op: 'info', out: 4 })); // the link drops before output arrives
  ws.linkDown = () => {};
  await ws.connect();
  ws.stopPing();
  // another tab answered 4..8 meanwhile; this tab still has nothing (rx_out 0)
  ws.frame(control({ op: 'info', out: 8 }));
  ws.frame(output(0, 'abcd\x1b[5nxyz'));
  assert.deepEqual(writes, [['abcd\x1b[5n', false], ['xyz', true]]);
});

test('replayed signals are dropped, except hellos', async () => {
  const { ws } = await session();
  const osc = (m) => '\x1b]5379;wosh;' + Buffer.from(JSON.stringify(m)).toString('base64') + '\x07';
  const signals = [];
  ws.onSignal = (m) => signals.push(m.t);
  let answered = null;
  ws.waiters.set('h1', (m) => { answered = m; });
  const old = osc({ t: 'typeahead', id: 'h1', text: 'bHMK' }) + osc({ t: 'answer', id: 'h1', sdp: 'old' }) + osc({ t: 'hello', id: 'h2' });
  ws.frame(control({ op: 'info', out: enc.encode(old).length }));
  ws.frame(output(0, old));
  assert.deepEqual(signals, ['hello']);
  assert.equal(answered, null, 'an old answer does not resolve a new offer');
  ws.frame(output(enc.encode(old).length, osc({ t: 'answer', id: 'h1', sdp: 'new' })));
  assert.equal(answered.sdp, 'new');
});

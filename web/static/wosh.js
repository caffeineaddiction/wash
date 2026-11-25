// wosh protocol client for the browser.
//
// ManagerConn: the WebSocket wash-web hands to washd (JSON requests).
// WoshSession: one wosh session. Frames are the same as wosh's data channel
// (repos/wosh/internal/wire/frame.go); they travel either over a WebRTC data
// channel straight to the wosh daemon (signaling through washd), or over a
// second WebSocket that washd bridges to the daemon. Output and input carry
// stream offsets, so reconnects replay missed output and resend unacked input.
//
// Embedding without washd: pass mgr = null and a signal function (see
// WoshSession). The file has no imports and no build step.

// VERSION of the browser client (this file and term/). Bump it on changes an
// embedder must know about; term/index.js carries the same value.
export const VERSION = '0.1.0';

export const F = {
  OUTPUT: 0x6f, INPUT: 0x69, ACK: 0x61, RESIZE: 0x72, REDRAW: 0x52, PING: 0x70, PONG: 0x50,
  EXIT: 0x78, EXIT_ACK: 0x58, KILL: 0x6b, CONTROL: 0x63, ECHO_ACK: 0x65,
};

const MAX_CHUNK = 16 * 1024;
const SIGNAL_TIMEOUT = 30000; // an embedder's signal function, like washd requests
const enc = new TextEncoder();

function u64(view, at) { return Number(view.getBigUint64(at)); }

function offsetFrame(t, off, data) {
  const b = new Uint8Array(9 + (data ? data.length : 0));
  const v = new DataView(b.buffer);
  b[0] = t;
  v.setBigUint64(1, BigInt(off));
  if (data) b.set(data, 9);
  return b;
}

function controlFrame(obj) {
  const j = enc.encode(JSON.stringify(obj));
  const b = new Uint8Array(1 + j.length);
  b[0] = F.CONTROL; b.set(j, 1);
  return b;
}

function resizeFrame(cols, rows) {
  const b = new Uint8Array(5);
  const v = new DataView(b.buffer);
  b[0] = F.RESIZE; v.setUint16(1, cols); v.setUint16(3, rows);
  return b;
}

// Relative to the page, so the site works under a path prefix (e.g. /wash/).
// host: which of the user's washds (one per host) the socket goes to.
function wsURL(ticket, host) {
  const q = `ticket=${encodeURIComponent(ticket)}` + (host ? `&host=${encodeURIComponent(host)}` : '');
  const u = new URL(`api/ws?${q}`, location.href);
  u.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return u.href;
}

export class AuthError extends Error {}

// --- in-band signaling (wosh internal/wire/wire.go) ---------------------------
// host -> client: ESC ] 5379 ; wosh ; <base64 json> BEL   (inside session output)
// client -> host: "WOSH:<base64 json>\r"                   (typed into the session)
const OSC_PREFIX = '\x1b]5379;wosh;';
const PROTO = 2;

function b64json(m) {
  const b = enc.encode(JSON.stringify({ v: PROTO, ...m }));
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s);
}

function unb64json(s) {
  const bin = atob(s.trim());
  const b = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i);
  return JSON.parse(new TextDecoder().decode(b));
}

export function b64bytes(s) {
  const bin = atob(s);
  const b = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i);
  return b;
}

export function encodeInput(m) { return enc.encode('WOSH:' + b64json(m) + '\r'); }

export function randomHex(n) {
  const b = crypto.getRandomValues(new Uint8Array(n));
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

function latin1(a) {
  let s = '';
  for (let i = 0; i < a.length; i += 8192) s += String.fromCharCode.apply(null, a.slice(i, i + 8192));
  return s;
}

// OSCFilter strips wosh messages from a byte stream (split anywhere) and
// passes everything else through.
class OSCFilter {
  constructor() { this.held = []; this.payload = []; this.inMsg = false; this.sawEsc = false; }
  write(p) {
    const out = new Uint8Array(p.length + this.held.length);
    let n = 0; const msgs = [];
    const P = OSC_PREFIX;
    for (let i = 0; i < p.length; i++) {
      const c = p[i];
      if (this.inMsg) {
        if (c === 0x07 || (this.sawEsc && c === 0x5c)) {
          try { msgs.push(unb64json(latin1(this.payload))); } catch {}
          this.inMsg = false; this.sawEsc = false; this.payload = [];
          continue;
        }
        if (c === 0x1b) { this.sawEsc = true; continue; }
        this.sawEsc = false;
        if (this.payload.length > (1 << 20)) { this.inMsg = false; this.payload = []; continue; }
        this.payload.push(c);
        continue;
      }
      if (this.held.length || c === 0x1b) {
        if (c === P.charCodeAt(this.held.length)) {
          this.held.push(c);
          if (this.held.length === P.length) { this.held = []; this.inMsg = true; }
          continue;
        }
        for (const h of this.held) out[n++] = h;
        this.held = [];
        if (c === 0x1b) { this.held.push(c); continue; }
      }
      out[n++] = c;
    }
    return { out: out.subarray(0, n), msgs };
  }
}

// open a handed-over socket and wait for washd's hello
function openSocket(ticket, host = '') {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsURL(ticket, host));
    ws.binaryType = 'arraybuffer';
    let done = false;
    const timer = setTimeout(() => { if (!done) { done = true; ws.close(); reject(new Error('timed out connecting to the shell manager')); } }, 20000);
    ws.onmessage = (ev) => {
      if (done || typeof ev.data !== 'string') return;
      const m = JSON.parse(ev.data);
      if (m.t === 'hello') { done = true; clearTimeout(timer); resolve({ ws, hello: m }); }
    };
    ws.onclose = (ev) => {
      if (done) return;
      done = true; clearTimeout(timer);
      const err = (ev.code === 4401 || ev.code === 4403) ? new AuthError(ev.reason || 'not authorized') : new Error(ev.reason || `connection closed (${ev.code})`);
      err.code = ev.code;
      reject(err);
    };
  });
}

// tabID identifies this browser tab to session daemons (shared sessions). It
// survives a reload, so a reloaded tab is the same client and keeps control.
function tabID() {
  try {
    let id = sessionStorage.getItem('wash.cid');
    if (!id) { id = randomHex(8); sessionStorage.setItem('wash.cid', id); }
    return id;
  } catch { return randomHex(8); }
}

// ManagerConn is the page's connection to one washd (host: the name wash-web
// knows it by; '' when the site has a single washd for this user).
export class ManagerConn {
  constructor(host = '') {
    this.host = host;
    this.ws = null; this.hello = null; this.rid = 0; this.pending = new Map();
    this.onSessions = () => {}; this.onState = () => {}; this.onAuthLost = () => {};
    this.cid = tabID(); // this browser tab, across reloads: the daemon knows it as one client
    this.closed = false; this.resume = null;
  }

  async connect(ticket) {
    const { ws, hello } = await openSocket(ticket, this.host);
    this.attach(ws, hello);
  }

  attach(ws, hello) {
    this.ws = ws; this.hello = hello; this.resume = hello.resume;
    this.onSessions(hello.sessions || []);
    this.onState('connected');
    ws.onmessage = (ev) => {
      if (typeof ev.data !== 'string') return;
      const m = JSON.parse(ev.data);
      if (m.t === 'sessions' && !m.rid) { this.onSessions(m.sessions || []); return; }
      if (m.t === 'chunk' && this.pending.has(m.rid)) { (this.pending.get(m.rid).chunks ||= []).push(m.data); return; }
      if (m.rid && this.pending.has(m.rid)) {
        const { resolve, reject, chunks } = this.pending.get(m.rid);
        if (chunks) m.chunks = chunks;
        this.pending.delete(m.rid);
        if (m.t === 'err') reject(new Error(m.err)); else resolve(m);
        if (m.t === 'sessions') this.onSessions(m.sessions || []);
      }
    };
    ws.onclose = (ev) => {
      for (const { reject } of this.pending.values()) reject(new Error('disconnected'));
      this.pending.clear();
      if (this.closed) return;
      if (ev.code === 4401 || ev.code === 4403 || ev.code === 4000) { this.onAuthLost(ev.reason || 'signed out'); return; }
      this.onState('reconnecting');
      this.reconnect();
    };
  }

  async reconnect() {
    let delay = 500;
    while (!this.closed) {
      await new Promise((r) => setTimeout(r, delay));
      if (!this.resume) { this.onAuthLost('connection lost'); return; }
      const t = this.resume;
      this.resume = null; // single use
      try {
        const { ws, hello } = await openSocket(t, this.host);
        this.attach(ws, hello);
        return;
      } catch (e) {
        if (e instanceof AuthError) { this.onAuthLost(e.message); return; }
        // the ticket may not have been consumed (web or link down): keep it
        this.resume = t;
        delay = Math.min(delay * 2, 10000);
      }
    }
  }

  request(msg, timeout = 30000) {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) { reject(new Error('not connected to the shell manager')); return; }
      const rid = ++this.rid;
      this.pending.set(rid, { resolve, reject });
      this.ws.send(JSON.stringify({ ...msg, rid }));
      setTimeout(() => { if (this.pending.has(rid)) { this.pending.delete(rid); reject(new Error(`${msg.t}: timed out`)); } }, timeout);
    });
  }

  close() { this.closed = true; if (this.ws) this.ws.close(); }
}

// --- wosh streams (repos/wosh/internal/stream) ------------------------------
// A wosh host opens extra data channels to its client, labelled
// "s:"+json(StreamSpec). Messages: [type][u64 seq][payload], acks
// ['K'][u64 next expected], orderly close ['C'][u64 seq]. The browser serves
// "build" (a wosh build for a chained hop's middle host, from washd) and
// refuses the rest (agent, src:, -R forwards are wosh-client features).
const S = { DATA: 0x64, FIN: 0x66, EXIT: 0x78, ERR: 0x21, ACK: 0x4b, CLOSE: 0x43, REFUSE: 0x5a };
const STREAM_CHUNK = 16 * 1024 - 8;
const buildCache = new Map(); // key -> Promise<{stamp, gz}>

function fetchBuild(mgr, key) {
  if (!buildCache.has(key)) {
    const p = mgr.request({ t: 'build', name: key }, 120000).then((m) => {
      const parts = (m.chunks || []).map(b64bytes);
      const gz = new Uint8Array(parts.reduce((n, x) => n + x.length, 0));
      let o = 0;
      for (const x of parts) { gz.set(x, o); o += x.length; }
      return { stamp: m.stamp, gz };
    });
    p.catch(() => buildCache.delete(key));
    buildCache.set(key, p);
  }
  return buildCache.get(key);
}

export function serveStream(mgr, dc) {
  let spec;
  try { spec = JSON.parse(dc.label.slice(2)); } catch { dc.close(); return; }
  dc.binaryType = 'arraybuffer';
  let seq = 0, rxNext = 0;
  const raw = (typ, p = new Uint8Array(0)) => {
    const b = new Uint8Array(1 + p.length); b[0] = typ; b.set(p, 1); dc.send(b);
  };
  const u64b = (n) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(n)); return b; };
  const msg = (typ, p = new Uint8Array(0)) => {
    const b = new Uint8Array(8 + p.length); b.set(u64b(seq++)); b.set(p, 8); raw(typ, b);
  };
  const drain = () => new Promise((r) => {
    if (dc.bufferedAmount < (1 << 20)) { r(); return; }
    dc.bufferedAmountLowThreshold = 1 << 19;
    dc.addEventListener('bufferedamountlow', r, { once: true });
  });
  dc.onmessage = (ev) => {
    const b = new Uint8Array(ev.data);
    if (!b.length || b[0] === S.ACK || b[0] === S.REFUSE || b.length < 9) return;
    if (Number(new DataView(b.buffer, 1).getBigUint64(0)) === rxNext) rxNext++;
    raw(S.ACK, u64b(rxNext)); // lets the opener's Close() finish
  };
  const run = async () => {
    if (spec.resume) { raw(S.REFUSE, enc.encode('unknown stream')); return; }
    if (spec.k !== 'build' || !mgr) {
      msg(S.ERR, enc.encode(`not supported by the wash browser client (${spec.k})`));
      msg(S.CLOSE);
      return;
    }
    try {
      const { stamp, gz } = await fetchBuild(mgr, spec.cmd || '');
      msg(S.EXIT, enc.encode(stamp));
      for (let i = 0; i < gz.length; i += STREAM_CHUNK) {
        await drain();
        msg(S.DATA, gz.subarray(i, i + STREAM_CHUNK));
      }
      msg(S.FIN);
    } catch (e) {
      msg(S.ERR, enc.encode(e.message));
    }
    msg(S.CLOSE);
    setTimeout(() => { try { dc.close(); } catch {} }, 30000);
  };
  if (dc.readyState === 'open') run(); else dc.onopen = run;
}

// --- transports ---------------------------------------------------------------

// signal(sdp) -> answer sdp: through washd for its own sessions, through the
// parent session's terminal for a chained hop, or through the embedder.
// ice: [{urls, username, credential}]. relay: TURN only.
async function webrtcTransport(mgr, { ice, relay }, signal, onFrame, onDown) {
  const cfg = { iceServers: (ice || []).map((s) => ({ urls: s.urls, username: s.username, credential: s.credential })) };
  if (relay) cfg.iceTransportPolicy = 'relay';
  const pc = new RTCPeerConnection(cfg);
  const dc = pc.createDataChannel('wosh');
  dc.binaryType = 'arraybuffer';
  pc.ondatachannel = (ev) => { if (ev.channel.label.startsWith('s:')) serveStream(mgr, ev.channel); };
  let down = false;
  const fail = () => { if (!down) { down = true; try { pc.close(); } catch {} onDown(); } };
  await pc.setLocalDescription(await pc.createOffer());
  // wosh signaling is not trickled: wait for gathering (bounded)
  await new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') { resolve(); return; }
    const t = setTimeout(resolve, 4000);
    pc.addEventListener('icegatheringstatechange', () => { if (pc.iceGatheringState === 'complete') { clearTimeout(t); resolve(); } });
  });
  try {
    const answer = await signal(pc.localDescription.sdp);
    await pc.setRemoteDescription({ type: 'answer', sdp: answer });
  } catch (e) { pc.close(); throw e; }
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => { reject(new Error('WebRTC did not connect')); }, 8000);
    dc.onopen = () => { clearTimeout(t); resolve(); };
    pc.addEventListener('connectionstatechange', () => {
      if (pc.connectionState === 'failed') { clearTimeout(t); reject(new Error('WebRTC failed')); }
    });
  }).catch((e) => { pc.close(); throw e; });
  dc.onmessage = (ev) => onFrame(new Uint8Array(ev.data));
  dc.onclose = fail;
  pc.addEventListener('connectionstatechange', () => {
    if (pc.connectionState === 'failed' || pc.connectionState === 'closed') fail();
  });
  return {
    kind: 'webrtc',
    send: (b) => { if (dc.readyState === 'open') dc.send(b); },
    buffered: () => dc.bufferedAmount,
    close: () => { down = true; try { pc.close(); } catch {} },
  };
}

async function bridgeTransport(mgr, id, size, rxOut, cid, take, onFrame, onDown) {
  const { ticket } = await mgr.request({ t: 'ticket' });
  const { ws } = await openSocket(ticket, mgr.host);
  let down = false;
  await new Promise((resolve, reject) => {
    ws.onmessage = (ev) => {
      if (typeof ev.data !== 'string') return;
      const m = JSON.parse(ev.data);
      if (m.t === 'bridged') resolve();
      else if (m.t === 'err') reject(new Error(m.err));
    };
    ws.onclose = (ev) => reject(new Error(ev.reason || 'bridge closed'));
    ws.send(JSON.stringify({ t: 'bridge', rid: 1, id, cols: size.cols, rows: size.rows, rx_out: rxOut, cid, take }));
  });
  ws.onmessage = (ev) => { if (typeof ev.data !== 'string') onFrame(new Uint8Array(ev.data)); };
  ws.onclose = () => { if (!down) { down = true; onDown(); } };
  return {
    kind: 'bridge',
    send: (b) => { if (ws.readyState === WebSocket.OPEN) ws.send(b); },
    buffered: () => ws.bufferedAmount,
    close: () => { down = true; ws.close(); },
  };
}

// --- session ------------------------------------------------------------------

export class WoshSession {
  // term: Terminal (write, onData, onResize, cols, rows)
  // parent + key: a chained hop (`wosh HOST` inside the parent session),
  // reached directly over WebRTC and signaled through the parent's terminal.
  //
  // Embedding without washd: mgr = null, and
  //   signal({sdp, cols, rows, rx_out, cid, take, join, ice, relay}) -> Promise<answer sdp>
  //     relays the offer to the daemon (e.g. POST to your server, which
  //     writes {"t":"offer",...} to the daemon's control socket). The daemon
  //     reads join, not take: forward join (watch if another client has
  //     control), and ice and relay so both ends use the same ICE servers.
  //     It times out after 30 s. Throw an Error whose message contains
  //     "gone" to end the session for good.
  //   cid: this client instance, for roles. Keep it per tab across reloads
  //     (e.g. in sessionStorage) so a reloaded tab keeps control. Default: a
  //     new random id per WoshSession.
  //   ice: ICE servers for the RTCPeerConnection (default: none, host
  //     candidates only). relay: with ice, use TURN only.
  // The transport is WebRTC only (the bridge needs washd).
  constructor(mgr, id, term, { transport = 'auto', onState = () => {}, onExit = () => {}, parent = null, key = null,
    signal = null, cid = null, ice = null, relay = false } = {}) {
    if (signal != null && typeof signal !== 'function') throw new Error('WoshSession: signal must be a function');
    if (!mgr && !signal) throw new Error('WoshSession: pass a manager or a signal function');
    this.mgr = mgr; this.id = id; this.term = term;
    this.mode = parent || !mgr ? 'webrtc' : transport; this.onState = onState; this.onExit = onExit;
    this.parent = parent; this.key = key;
    this.signalFn = signal; this.ice = ice; this.iceRelay = relay; // not this.relay: that is relay()
    this.cid = cid || (mgr && mgr.cid) || randomHex(8);
    this.filter = new OSCFilter();
    this.token = null;          // from the daemon's info frame: proves chained-hop hellos
    this.waiters = new Map();   // hop id -> resolve(answer|err msg)
    this.onSignal = () => {};   // hello / typeahead seen in this session's output
    this.sigTimeouts = 0;
    this.synced = false;        // got this link's first ack
    this.everSynced = false;
    this.rxOut = 0;              // output received up to
    // output below this offset was in the ring before this tab first
    // connected: replay (no query replies). Set by the info frame of each
    // link while this tab has no output yet (rx_out 0), then kept across
    // reconnects.
    this.replayEnd = 0;
    this.inBase = 0;             // input acknowledged up to
    this.inBuf = new Uint8Array(0); // unacknowledged input, starting at inBase
    this.tr = null; this.closed = false; this.exited = false;
    // Shared sessions: several tabs (devices) can watch a session; one has
    // control. role is 'control' or 'view' (from the daemon; an old daemon
    // never says, and then we always have control).
    this.role = 'control';
    this.take = false;          // next connect asks for control (else: control only if free)
    this.shared = null;         // {cols, rows} the controller set (daemon "size" messages)
    this.rtt = null; this.lastPong = 0; this.pingN = 0; this.pingSent = new Map();
    this.preferBridge = transport === 'bridge';
    term.onData = (d) => this.input(typeof d === 'string' ? enc.encode(d) : d);
    term.onResize = (c, r) => { if (this.role === 'control') this.send(resizeFrame(c, r)); };
  }

  size() { return { cols: this.term.cols || 80, rows: this.term.rows || 24 }; }

  async connect() {
    let delay = 300;
    while (!this.closed && !this.exited) {
      this.onState({ state: 'connecting' });
      try {
        this.synced = false; this.flushPending = true;
        const tr = await this.open();
        // closed (or ended) while the link was coming up: drop it
        if (this.closed || this.exited) { tr.close(); return; }
        this.tr = tr;
        this.take = false; // reconnects keep whatever role we have
        // the first ack may have arrived while open() was finishing
        if (this.synced && this.flushPending) { this.flushPending = false; this.flushInput(); }
        this.sigTimeouts = 0;
        this.lastPong = performance.now();
        this.onState({ state: 'up', transport: this.tr.kind });
        // the daemon starts sending at rx_out; resend input it has not acked
        if (this.role === 'control') this.send(resizeFrame(this.size().cols, this.size().rows));
        // input goes out after the daemon's first ack on this link (offsets)
        this.startPing();
        return;
      } catch (e) {
        if (this.closed || this.exited) return; // closed while connecting: nothing to retry
        this.onState({ state: 'down', error: e.message });
        if (/no session|session not found|gone/.test(e.message)) { this.exited = true; this.onExit(null, e.message); return; }
        if (this.parent && /signal timeout/.test(e.message) && ++this.sigTimeouts >= 2) {
          // nothing parked in the parent answers any more: stop typing offers into its shell
          this.exited = true; this.onExit(null, 'the wosh relay in the parent session is gone'); return;
        }
        if (this.parent && this.parent.exited) { this.exited = true; this.onExit(null, 'parent session ended'); return; }
        await new Promise((r) => setTimeout(r, delay));
        delay = Math.min(delay * 2, 8000);
      }
    }
  }

  // signal sends an offer and returns the answer's SDP. An answer that
  // arrives after close() is refused, so the RTCPeerConnection never opens:
  // a late peer with this cid would replace the one a new WoshSession on
  // the same cid (a resumed pane, a reload) has just opened.
  signal(sdp) {
    return this.sendOffer(sdp).then((a) => {
      if (this.closed || this.exited) throw new Error('closed while connecting');
      return a;
    });
  }

  sendOffer(sdp) {
    const { cols, rows } = this.size();
    if (!this.parent && this.signalFn) {
      const { ice, relay } = this.iceConfig();
      const req = { sdp, cols, rows, rx_out: this.rxOut, cid: this.cid, take: this.take, join: !this.take, ice, relay };
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('offer: timed out')), SIGNAL_TIMEOUT);
        Promise.resolve().then(() => this.signalFn(req)).then((answer) => {
          clearTimeout(t);
          if (typeof answer === 'string' && answer) resolve(answer);
          else reject(new Error('offer: the signal function returned no answer SDP'));
        }, (e) => {
          clearTimeout(t);
          // connect() reads e.message ("gone" ends the session)
          reject(e instanceof Error ? e : new Error(e == null ? 'offer failed' : String(e)));
        });
      });
    }
    if (!this.parent) {
      return this.mgr.request({ t: 'offer', id: this.id, sdp, cols, rows, rx_out: this.rxOut, cid: this.cid, take: this.take }).then((a) => a.sdp);
    }
    const h = (this.mgr && this.mgr.hello) || {};
    const ice = this.iceConfig();
    return this.parent.relay({
      t: 'offer', id: this.id, key: this.key, sdp, ice: ice.ice, relay: ice.relay,
      term: 'xterm-256color', cols, rows, rx_out: this.rxOut, user: h.user, cid: this.cid, join: !this.take,
      env: { COLORTERM: 'truecolor', TERM_PROGRAM: 'wash' },
    }).then((a) => {
      if (a.t === 'err') throw new Error(a.err || 'hop refused');
      return a.sdp;
    });
  }

  // relay: a child hop's offer goes out as a WOSH: input line in this
  // session; the parked `wosh` answers with an OSC message in our output.
  relay(msg, timeout = 30000) {
    return new Promise((resolve, reject) => {
      const done = (m) => { clearTimeout(t); this.waiters.delete(msg.id); resolve(m); };
      const t = setTimeout(() => { this.waiters.delete(msg.id); reject(new Error('signal timeout')); }, timeout);
      this.waiters.set(msg.id, done);
      this.input(encodeInput(msg));
    });
  }

  // say sends a one-way message to a relay parked in this session (bye).
  say(msg) { this.input(encodeInput(msg)); }

  // iceConfig: the embedder's ICE list and relay flag, else washd's (hello).
  // urls goes out as a list: the daemon rejects a bare string, which
  // RTCPeerConnection would take.
  iceConfig() {
    const h = (this.mgr && this.mgr.hello) || {};
    const ice = this.ice || h.ice || [];
    const relay = this.ice ? !!this.iceRelay : !!h.relay;
    return { ice: ice.map((s) => ({ ...s, urls: Array.isArray(s.urls) ? s.urls : [s.urls] })), relay };
  }

  async open() {
    const down = () => this.linkDown();
    const onFrame = (b) => this.frame(b);
    if (this.mode === 'webrtc' || (this.mode === 'auto' && !this.preferBridge)) {
      try {
        return await webrtcTransport(this.mgr, this.iceConfig(), (sdp) => this.signal(sdp), onFrame, down);
      } catch (e) {
        if (this.mode === 'webrtc') throw e;
        console.warn('wash: WebRTC failed, using the WebSocket bridge:', e.message);
        this.preferBridge = true; // until a reload; roaming back is cheap to retry later
      }
    }
    return bridgeTransport(this.mgr, this.id, this.size(), this.rxOut, this.cid, this.take, onFrame, down);
  }

  // takeControl makes this tab the one that types into the session; the
  // tab that had control keeps watching.
  takeControl() {
    if (this.closed || this.exited || this.role === 'control') return;
    if (this.tr) this.send(controlFrame({ op: 'take' }));
    else this.take = true; // asked while reconnecting
  }

  // layout: watching draws the controller's grid (scaled to fit); in
  // control the grid fits this screen and its size goes to the session.
  layout() {
    if (this.term.setFixedSize) this.term.setFixedSize(this.role === 'view' ? this.shared : null);
  }

  setRole(role) {
    if (role !== 'control' && role !== 'view') return;
    const was = this.role;
    this.role = role;
    this.layout();
    if (role === 'view') {
      this.inBuf = new Uint8Array(0); // typing here no longer goes anywhere
    } else if (was === 'view') {
      // the daemon follows this with an ack: continue from its input offset
      // (keys typed before it arrives are sent then)
      this.synced = false; this.everSynced = false; this.inBuf = new Uint8Array(0);
      this.flushPending = true;
      // the screen was laid out for the other device: our size, then a repaint
      this.send(resizeFrame(this.size().cols, this.size().rows));
      this.send(new Uint8Array([F.REDRAW]));
    }
    this.onState({ state: 'up', transport: this.tr && this.tr.kind, rtt: this.rtt });
  }

  linkDown() {
    if (this.closed || this.exited) return;
    this.stopPing();
    this.tr = null;
    this.connect();
  }

  send(b) { if (this.tr) this.tr.send(b); }

  input(bytes) {
    if (this.exited || this.role !== 'control') return;
    const prevEnd = this.inBase + this.inBuf.length;
    const nb = new Uint8Array(this.inBuf.length + bytes.length);
    nb.set(this.inBuf); nb.set(bytes, this.inBuf.length);
    this.inBuf = nb;
    if (!this.tr || !this.synced) return; // sent once the link's first ack sets the offset
    for (let i = 0; i < bytes.length; i += MAX_CHUNK) {
      this.send(offsetFrame(F.INPUT, prevEnd + i, bytes.subarray(i, i + MAX_CHUNK)));
    }
  }

  flushInput() {
    for (let i = 0; i < this.inBuf.length; i += MAX_CHUNK) {
      this.send(offsetFrame(F.INPUT, this.inBase + i, this.inBuf.subarray(i, i + MAX_CHUNK)));
    }
  }

  frame(b) {
    if (!b.length) return;
    const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
    switch (b[0]) {
      case F.OUTPUT: {
        if (b.length < 9) return;
        const off = u64(v, 1);
        let data = b.subarray(9);
        const end = off + data.length;
        if (end <= this.rxOut) return;
        if (off < this.rxOut) data = data.subarray(this.rxOut - off);
        this.rxOut = end;
        // output below replayEnd was in the ring before this tab connected:
        // its terminal queries were answered back then, so draw it without
        // replying. Output made while a resumed link was down still answers.
        const quiet = Math.max(0, Math.min(this.replayEnd - (end - data.length), data.length));
        const msgs = [];
        for (const [part, replies] of [[data.subarray(0, quiet), false], [data.subarray(quiet), true]]) {
          if (!part.length) continue;
          const r = this.filter.write(part);
          if (r.out.length) this.term.write(r.out, { replies });
          // replayed signals are stale (answers to old offers, typeahead that
          // was delivered then); only a hello can matter (a relay still parked)
          for (const m of r.msgs) if (replies || m.t === 'hello') msgs.push(m);
        }
        for (const m of msgs) {
          if ((m.t === 'answer' || m.t === 'err') && this.waiters.has(m.id)) this.waiters.get(m.id)(m);
          else this.onSignal(m);
        }
        break;
      }
      case F.CONTROL: {
        try {
          const c = JSON.parse(new TextDecoder().decode(b.subarray(1)));
          if (c.op === 'info' && c.token) this.token = c.token;
          // info comes before any output on a link, so rxOut is where it
          // starts. With no output yet, the newest info counts: a controller
          // may have answered more output since an earlier link's info.
          if (c.op === 'info' && this.rxOut === 0) this.replayEnd = c.out > 0 ? c.out : 0;
          if (c.op === 'role') this.setRole(c.role);
          if (c.op === 'size' && c.cols > 0 && c.rows > 0) { this.shared = { cols: c.cols, rows: c.rows }; this.layout(); }
        } catch {}
        break;
      }
      case F.ACK: {
        if (b.length < 9) return;
        const off = u64(v, 1);
        if (!this.synced) {
          // first ack on this link (the daemon sends one when the channel
          // opens): it is how much input the session has ever received.
          // A fresh page, or another browser having typed since, means our
          // offsets are behind; the daemon drops input below its offset, so
          // rebase what we have buffered onto it and send it again.
          if (!this.everSynced || off > this.inBase + this.inBuf.length) this.inBase = off;
          this.synced = this.everSynced = true;
        }
        if (off > this.inBase) {
          const n = Math.min(off - this.inBase, this.inBuf.length);
          this.inBuf = this.inBuf.slice(n);
          this.inBase += n;
        }
        if (this.flushPending && this.tr) { this.flushPending = false; this.flushInput(); }
        break;
      }
      case F.PONG: {
        const n = u64(v, 1);
        const t = this.pingSent.get(n);
        this.pingSent.delete(n);
        this.lastPong = performance.now();
        if (t !== undefined) {
          const r = performance.now() - t;
          this.rtt = this.rtt == null ? r : this.rtt * 0.8 + r * 0.2;
          this.onState({ state: 'up', transport: this.tr && this.tr.kind, rtt: this.rtt });
        }
        break;
      }
      case F.EXIT: {
        const code = b.length >= 5 ? v.getInt32(1) : 255;
        this.send(new Uint8Array([F.EXIT_ACK]));
        this.exited = true;
        this.stopPing();
        setTimeout(() => this.tr && this.tr.close(), 200);
        this.onExit(code);
        break;
      }
      default: // FEchoAck: not used by the browser client (no prediction)
    }
  }

  startPing() {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      if (!this.tr) return;
      if (performance.now() - this.lastPong > 6000) {
        // link silently dead (roamed, slept): reconnect like wosh does
        const tr = this.tr;
        this.tr = null;
        tr.close();
        this.linkDown();
        return;
      }
      const n = ++this.pingN;
      this.pingSent.set(n, performance.now());
      if (this.pingSent.size > 16) this.pingSent.delete(this.pingSent.keys().next().value);
      this.send(offsetFrame(F.PING, n));
    }, 1000);
  }

  stopPing() { if (this.pingTimer) clearInterval(this.pingTimer); this.pingTimer = null; }

  redraw() { this.send(new Uint8Array([F.REDRAW])); }

  kill() { this.send(new Uint8Array([F.KILL])); }

  close() {
    this.closed = true;
    this.stopPing();
    if (this.tr) this.tr.close();
    this.tr = null;
  }
}

// Focus parties: a host and guests sharing one session in real time.
//
// Devices connect to each other with WebRTC. To find each other they pass a
// short handshake through public MQTT message brokers (several at once, so
// one being down or blocked doesn't matter), the same kind of free public
// infrastructure other peer-to-peer web apps use.
//
// Privacy, by design:
// - The party code never leaves your device. Brokers only see a topic name
//   that is a one-way hash of it.
// - Every handshake message is sealed with AES-256-GCM under a key derived
//   from the code (PBKDF2, 200,000 rounds): brokers see only ciphertext, and
//   nobody without the code can read, join or forge anything. Guessing codes
//   is deliberately slow.
// - "Private" parties (the default) send everything through the brokers,
//   sealed the same way, so your IP address is never given to anyone in the
//   party, not even encrypted. (Over the internet a direct connection can't
//   hide it: the other device has to send packets to your address.)
// - Like any server you connect to, the brokers see the address that
//   connects to them, but not who you're talking to or what you say.
//
// The host's tab is the source of truth: guests receive its state and send
// requests, and the host decides what happens.

const DEFAULT_BROKERS = ['wss://broker.emqx.io:8084/mqtt', 'wss://broker.hivemq.com:8884/mqtt', 'wss://test.mosquitto.org:8081/mqtt'];
const STUN = { urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] };
// Free public TURN relays, for private connections and strict networks.
const TURN = [
  { urls: ['turn:openrelay.metered.ca:80', 'turn:openrelay.metered.ca:443', 'turn:openrelay.metered.ca:443?transport=tcp'], username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: ['turn:eu-0.turn.peerjs.com:3478', 'turn:us-0.turn.peerjs.com:3478'], username: 'peerjs', credential: 'peerjsp' },
];
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I/L
export const CODE_LENGTH = 8;
export const MAX_GUESTS = 12;
const PROTOCOL = 2;
const REQUEST_KINDS = ['toggle', 'skip', 'reset', 'mode', 'more', 'sound', 'mix', 'task', 'done', 'message', 'break'];

export const supported =
  typeof RTCPeerConnection === 'function' && typeof WebSocket === 'function' && Boolean(globalThis.crypto && crypto.subtle);

const enc = new TextEncoder();
const dec = new TextDecoder();
const hex = (buf) => [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, '0')).join('');
const randomId = () => hex(crypto.getRandomValues(new Uint8Array(8)));
const b64 = (bytes) => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const unb64 = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/** A random party code like "K7QX2M9P" (no look-alike characters). */
export function makeCode() {
  let out = '';
  while (out.length < CODE_LENGTH) {
    for (const b of crypto.getRandomValues(new Uint8Array(CODE_LENGTH))) {
      // Skip the top of the range so every character is equally likely.
      if (out.length < CODE_LENGTH && b < 256 - (256 % ALPHABET.length)) out += ALPHABET[b % ALPHABET.length];
    }
  }
  return out;
}

export const formatCode = (code) => `${code.slice(0, 4)}-${code.slice(4)}`;

/** Clean up a typed or pasted code; null if it can't be one. */
export function normalizeCode(input) {
  const c = String(input || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return c.length === CODE_LENGTH && [...c].every((ch) => ALPHABET.includes(ch)) ? c : null;
}

/** The party's public meeting place (a hash of the code) and the secret key. */
async function secretsFor(code) {
  const topic = `tempo/p/${hex(await crypto.subtle.digest('SHA-256', enc.encode(`tempo-party/topic/${code}`))).slice(0, 40)}`;
  const base = await crypto.subtle.importKey('raw', enc.encode(code), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: enc.encode('tempo-party/key/v1'), iterations: 200000, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
  return { topic, key };
}

async function seal(key, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const box = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(obj))));
  const out = new Uint8Array(iv.length + box.length);
  out.set(iv);
  out.set(box, iv.length);
  return b64(out);
}

/** Decrypt a sealed message; null if it wasn't made with this key. */
async function open(key, text) {
  try {
    const all = unb64(String(text));
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: all.slice(0, 12) }, key, all.slice(12));
    const obj = JSON.parse(dec.decode(plain));
    return obj && typeof obj === 'object' ? obj : null;
  } catch {
    return null;
  }
}

// Tests (and anyone self-hosting) can point at other brokers and relays.
function config() {
  try {
    const raw = JSON.parse(localStorage.getItem('tempo:signal') || 'null');
    if (raw && typeof raw === 'object') return raw;
  } catch {
    /* use the defaults */
  }
  return {};
}

function iceConfig(privately) {
  const custom = config().iceServers;
  const iceServers = Array.isArray(custom) ? custom : privately ? TURN : [STUN, ...TURN];
  // Private: only relayed routes, so no device's own address is ever offered.
  return { iceServers, iceTransportPolicy: privately ? 'relay' : 'all' };
}

// ---------------------------------------------------------------------------
// A tiny MQTT 3.1.1 client over WebSocket: connect, subscribe, publish (QoS 0).

const mqttStr = (s) => {
  const b = enc.encode(s);
  return [b.length >> 8, b.length & 255, ...b];
};
function mqttPacket(first, body) {
  const len = [];
  let n = body.length;
  do {
    let byte = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) byte |= 128;
    len.push(byte);
  } while (n > 0);
  return new Uint8Array([first, ...len, ...body]);
}

function mqttConnect(url, topics, onPublish) {
  return new Promise((resolve, reject) => {
    let ws;
    try {
      ws = new WebSocket(url, 'mqtt');
    } catch (err) {
      reject(new Error(`blocked (${err && err.name})`));
      return;
    }
    ws.binaryType = 'arraybuffer';
    let buf = new Uint8Array(0);
    let ready = false;
    let ping = 0;
    const send = (bytes) => ws.readyState === 1 && ws.send(bytes);
    const conn = {
      onclose: null,
      publish(topic, text) {
        send(mqttPacket(0x30, [...mqttStr(topic), ...enc.encode(text)]));
      },
      close() {
        conn.onclose = null;
        clearInterval(ping);
        try {
          ws.close();
        } catch {
          /* closed */
        }
      },
    };
    const timer = setTimeout(() => {
      if (ready) return;
      reject(new Error('timeout'));
      conn.close();
    }, 12000);
    ws.onopen = () => {
      // CONNECT: protocol "MQTT" level 4, clean session, keep-alive 60 s.
      send(mqttPacket(0x10, [...mqttStr('MQTT'), 4, 0x02, 0, 60, ...mqttStr(`tempo${randomId()}`)]));
    };
    ws.onmessage = (e) => {
      const chunk = new Uint8Array(e.data);
      const all = new Uint8Array(buf.length + chunk.length);
      all.set(buf);
      all.set(chunk, buf.length);
      buf = all;
      // Read whole packets out of the buffer.
      for (;;) {
        if (buf.length < 2) return;
        let len = 0;
        let mult = 1;
        let i = 1;
        for (; i < 5; i++) {
          if (i >= buf.length) return;
          len += (buf[i] & 127) * mult;
          mult *= 128;
          if (!(buf[i] & 128)) break;
        }
        const start = i + 1;
        if (buf.length < start + len) return;
        const type = buf[0] >> 4;
        const flags = buf[0] & 15;
        const body = buf.subarray(start, start + len);
        buf = buf.slice(start + len);
        if (type === 2) {
          // CONNACK
          if (body[1] !== 0) {
            clearTimeout(timer);
            reject(new Error(`refused (${body[1]})`));
            conn.close();
            return;
          }
          const subs = [0, 1];
          for (const t of topics) subs.push(...mqttStr(t), 0);
          send(mqttPacket(0x82, subs));
        } else if (type === 9) {
          // SUBACK: listening.
          ready = true;
          clearTimeout(timer);
          ping = setInterval(() => send(new Uint8Array([0xc0, 0])), 30000);
          resolve(conn);
        } else if (type === 3) {
          // PUBLISH
          const tlen = (body[0] << 8) | body[1];
          const topic = dec.decode(body.subarray(2, 2 + tlen));
          const skip = flags & 6 ? 2 : 0; // a packet id comes with QoS 1 and 2
          onPublish(topic, dec.decode(body.subarray(2 + tlen + skip)));
        }
      }
    };
    ws.onerror = () => {
      if (!ready) {
        clearTimeout(timer);
        reject(new Error('error'));
      }
    };
    ws.onclose = (e) => {
      clearInterval(ping);
      if (!ready) {
        clearTimeout(timer);
        reject(new Error(`closed ${e.code}`));
      } else if (conn.onclose) {
        conn.onclose();
      }
    };
  });
}

/**
 * Listen on `topics` through every broker we can reach (at least one), and
 * publish through all of them. Duplicates are dropped by the caller.
 */
async function openSignal(topics, onMessage) {
  const urls = Array.isArray(config().brokers) ? config().brokers : DEFAULT_BROKERS;
  const conns = new Set();
  const problems = [];
  let closed = false;
  const connectOne = async (url, attempt) => {
    try {
      const c = await mqttConnect(url, topics, onMessage);
      if (closed) {
        c.close();
        return false;
      }
      conns.add(c);
      // A broker that drops us is reconnected quietly.
      c.onclose = () => {
        conns.delete(c);
        if (!closed) setTimeout(() => !closed && connectOne(url, 0), 3000);
      };
      return true;
    } catch (err) {
      let host = url;
      try {
        host = new URL(url).hostname;
      } catch {
        /* keep the url */
      }
      problems.push(`${host} ${err.message}`);
      if (!closed && attempt < 5) setTimeout(() => !closed && connectOne(url, attempt + 1), 4000 * (attempt + 1));
      return false;
    }
  };
  await new Promise((resolve, reject) => {
    let left = urls.length;
    let done = false;
    if (!left) reject(new Error('network:no brokers'));
    urls.forEach((u) => connectOne(u, 0).then((ok) => {
      if (done) return;
      if (ok) {
        done = true;
        resolve();
      } else if (--left === 0) {
        done = true;
        closed = true;
        reject(new Error(`network:${problems.join('; ')}`));
      }
    }));
  });
  return {
    send(topic, text) {
      conns.forEach((c) => c.publish(topic, text));
    },
    close() {
      closed = true;
      conns.forEach((c) => c.close());
      conns.clear();
    },
  };
}

// ---------------------------------------------------------------------------
// WebRTC: one complete offer and one complete answer (all routes included),
// so a lost message is simply sent again.

// Wait until there's a usable route (a relay one in private mode), plus a
// moment for more to arrive, rather than for every server to answer.
async function gathered(pc, privately) {
  if (pc.iceGatheringState === 'complete') return;
  await new Promise((resolve) => {
    let finished = false;
    let grace = 0;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(cap);
      clearTimeout(grace);
      pc.removeEventListener('icegatheringstatechange', onState);
      pc.removeEventListener('icecandidate', onCandidate);
      resolve();
    };
    const onState = () => pc.iceGatheringState === 'complete' && finish();
    const onCandidate = (e) => {
      if (!e.candidate) return finish();
      if (grace || (privately && e.candidate.type && e.candidate.type !== 'relay')) return;
      grace = setTimeout(finish, privately ? 400 : 900);
    };
    const cap = setTimeout(finish, 5000);
    pc.addEventListener('icegatheringstatechange', onState);
    pc.addEventListener('icecandidate', onCandidate);
  });
}

/** The local description, ready to send; in private mode only relay routes. */
function shareable(pc, privately) {
  let { sdp } = pc.localDescription;
  if (privately) {
    sdp = sdp
      .split('\r\n')
      .filter((line) => !line.startsWith('a=candidate') || / typ relay /.test(line))
      // A relay route notes where the relay saw you come from; blank that.
      .map((line) => line.replace(/ raddr \S+ rport \d+/, ' raddr 0.0.0.0 rport 0'))
      .join('\r\n');
  }
  return { type: pc.localDescription.type, sdp };
}

function newPeer(privately, onState) {
  const pc = new RTCPeerConnection(iceConfig(privately));
  pc.onconnectionstatechange = () => onState(pc.connectionState);
  return pc;
}

const closePc = (pc) => {
  try {
    pc.close();
  } catch {
    /* already closed */
  }
};

// Remember message ids for a while, so copies from the other brokers are ignored.
function dedupe() {
  const seen = new Map();
  return (mid) => {
    if (!mid || seen.has(mid)) return false;
    seen.set(mid, Date.now());
    if (seen.size > 2000) seen.delete(seen.keys().next().value);
    return true;
  };
}

/**
 * Start hosting. Resolves with { code, broadcast(state), answer(guestId, reqId, ok, text, extra),
 * setAccess(guestId, access), remove(guestId), members(), end() } once the party can be joined.
 *
 * Guests reach the host in one of two ways:
 * - private (relayed): every message goes through the brokers, sealed with the
 *   code's key. Nobody ever learns anyone's IP address, and no TURN server is
 *   needed. This is what a private host always uses.
 * - direct: a WebRTC connection, a little faster, but the two devices learn
 *   each other's addresses. Only when both host and guest turned privacy off.
 *
 * hooks: getState() → the state to share; accessFor(guest) → what a new
 * guest may do (sent to them, and their role shown to everyone);
 * onJoin(guest), onLeave(guest), onRequest(guest, request), onSignal(online).
 * The host's app enforces the rules: a guest's own app only mirrors them.
 */
export async function host(name, hooks, { private: privately = true } = {}) {
  const code = makeCode();
  const secrets = await secretsFor(code);
  const guests = new Map(); // connection id → guest
  const fresh = dedupe();
  let ended = false;
  let signal = null;

  const say = async (topic, body) => signal && signal.send(topic, await seal(secrets.key, { ...body, mid: randomId() }));
  const send = (g, msg) => {
    if (g.via === 'relay') {
      g.seq += 1;
      say(g.reply, { t: 'msg', cid: g.id, seq: g.seq, data: msg });
    } else if (g.ch && g.ch.readyState === 'open') {
      try {
        g.ch.send(JSON.stringify(msg));
      } catch {
        /* closing */
      }
    }
  };
  const removed = new Set(); // connection ids the host sent away
  const memberList = () => [
    { id: 'host', name, host: true },
    ...[...guests.values()].filter((g) => g.ready).map((g) => ({ id: g.id, name: g.name, role: (g.access && g.access.role) || '' })),
  ];
  const sendMembers = () => {
    const members = memberList();
    guests.forEach((g) => g.ready && send(g, { t: 'members', members }));
  };
  const welcome = (g) => send(g, { t: 'welcome', id: g.id, host: name, state: hooks.getState(), members: memberList(), access: g.access, now: Date.now() });

  function drop(g) {
    if (guests.get(g.id) !== g) return;
    guests.delete(g.id);
    if (g.pc) closePc(g.pc);
    if (g.ready && !ended) {
      hooks.onLeave(g);
      sendMembers();
    }
  }

  // What a guest says, whichever way it arrives.
  function fromGuest(g, m) {
    if (!m || typeof m !== 'object' || g.removed) return;
    g.lastSeen = Date.now();
    if (m.t === 'hello' && !g.ready) {
      g.name = str(m.name, 24) || 'Guest';
      g.access = hooks.accessFor ? hooks.accessFor(g) : null;
      g.ready = true;
      welcome(g);
      hooks.onJoin(g);
      sendMembers();
    } else if (m.t === 'ping') {
      send(g, { t: 'pong', c: m.c, h: Date.now() });
    } else if (m.t === 'req' && g.ready && REQUEST_KINDS.includes(m.kind)) {
      // A flood guard under the app's own rules: past 10 requests in 10 s,
      // the rest are dropped without bothering the host.
      const now = Date.now();
      g.reqs = (g.reqs || []).filter((t) => now - t < 10000);
      if (g.reqs.length >= 10) return;
      g.reqs.push(now);
      hooks.onRequest(g, { id: Number(m.id) || 0, kind: m.kind, data: m.data ?? null, label: str(m.label, 140) });
    } else if (m.t === 'bye') {
      drop(g);
    }
  }

  async function onMessage(topic, text) {
    if (ended || topic !== secrets.topic) return;
    const body = await open(secrets.key, text);
    if (!body || !fresh(body.mid)) return; // not someone with the code, or a copy
    const cid = str(body.cid, 64);
    const reply = str(body.reply, 120);
    if (!cid) return;
    const known = guests.get(cid);

    if (body.t === 'msg') {
      if (known && known.via === 'relay') fromGuest(known, body.data);
      return;
    }
    if (!reply.startsWith(`${secrets.topic}/`)) return;

    if (removed.has(cid)) {
      say(reply, { t: 'removed', cid });
      return;
    }
    if (body.t === 'knock') {
      // A private guest at the door (they knock until welcomed).
      if (known) {
        if (known.ready && known.via === 'relay') welcome(known);
        return;
      }
      if (guests.size >= MAX_GUESTS) {
        say(reply, { t: 'full', cid });
        return;
      }
      const g = { id: cid, via: 'relay', reply, seq: 0, name: 'Guest', ready: false, lastSeen: Date.now() };
      guests.set(cid, g);
      fromGuest(g, { t: 'hello', name: body.name });
      return;
    }

    if (body.t === 'offer' && body.sdp) {
      // A guest asking for a direct connection. A private host keeps everyone
      // relayed, so nobody learns anyone's address.
      if (privately) {
        say(reply, { t: 'relay', cid });
        return;
      }
      if (known) {
        // They knocked again: our answer must have got lost, so resend it.
        if (!known.ready && known.answer) say(reply, known.answer);
        return;
      }
      if (guests.size >= MAX_GUESTS) {
        say(reply, { t: 'full', cid });
        return;
      }
      const g = { id: cid, via: 'direct', name: 'Guest', ready: false, answer: null, lastSeen: Date.now() };
      g.pc = newPeer(false, (s) => {
        if (s === 'failed' || s === 'closed') drop(g);
      });
      g.pc.ondatachannel = (e) => {
        g.ch = e.channel;
        g.ch.onmessage = (ev) => {
          try {
            fromGuest(g, JSON.parse(ev.data));
          } catch {
            /* not for us */
          }
        };
        g.ch.onclose = () => drop(g);
      };
      guests.set(cid, g);
      try {
        await g.pc.setRemoteDescription(body.sdp);
        await g.pc.setLocalDescription(await g.pc.createAnswer());
        await gathered(g.pc, false);
        g.answer = { t: 'answer', cid, sdp: shareable(g.pc, false) };
        await say(reply, g.answer);
      } catch {
        drop(g);
        return;
      }
      setTimeout(() => {
        if (!g.ready) drop(g);
      }, 45000);
    }
  }

  signal = await openSignal([secrets.topic], (topic, text) => onMessage(topic, text));
  hooks.onSignal(true);

  // Everyone gets the full state now and then anyway, to correct any drift
  // or a lost message; relayed guests who go quiet for 40 s have left.
  const heartbeat = setInterval(() => {
    const state = hooks.getState();
    const now = Date.now();
    guests.forEach((g) => {
      if (g.via === 'relay' && now - g.lastSeen > 40000) drop(g);
      else if (g.ready) send(g, { t: 'state', state, now });
    });
  }, 10000);

  const controller = {
    code,
    private: privately,
    members: memberList,
    broadcast(state) {
      const msg = { t: 'state', state, now: Date.now() };
      guests.forEach((g) => g.ready && send(g, msg));
    },
    /** extra: { auto } for an answer the app gave by itself, { wait } ms until they may ask again. */
    answer(guestId, reqId, ok, text = '', { auto = false, wait = 0 } = {}) {
      const g = guests.get(guestId);
      if (g) send(g, { t: 'ans', id: reqId, ok: Boolean(ok), text: str(text, 140), auto: Boolean(auto), wait: Math.max(0, Math.round(Number(wait) || 0)) });
    },
    /** What this guest may do (the app decides what's in it); everyone sees the new roles. */
    setAccess(guestId, access) {
      const g = guests.get(guestId);
      if (!g || !g.ready) return;
      g.access = access;
      send(g, { t: 'access', access });
      sendMembers();
    },
    /** Send a guest away. They can come back only by joining again. */
    remove(guestId) {
      const g = guests.get(guestId);
      if (!g) return;
      g.removed = true;
      removed.add(g.id);
      send(g, { t: 'end', why: 'removed' });
      setTimeout(() => drop(g), 400);
    },
    end() {
      if (ended) return;
      ended = true;
      clearInterval(heartbeat);
      guests.forEach((g) => {
        send(g, { t: 'end' });
        if (g.pc) setTimeout(() => closePc(g.pc), 400);
      });
      guests.clear();
      // Let the goodbyes go out through the brokers first.
      setTimeout(() => signal.close(), 600);
    },
  };
  return controller;
}

/**
 * Join the party with this code. Resolves with { request(kind, data, label),
 * offset(), leave() } once the host has welcomed us.
 *
 * Private (the default) relays everything through the brokers, sealed, so
 * no IP address is ever shared. Direct tries a WebRTC connection, and falls
 * back to relaying if the host keeps their party private.
 *
 * hooks: onWelcome(msg, controller), onState(state), onMembers(list),
 * onAccess(access), onAnswer(answer), onEnd(reason) where reason is 'ended',
 * 'removed' or 'lost'.
 * Rejects with Error('not-found' | 'full' | 'removed' | 'unreachable' | 'network:…' | 'setup:…').
 */
export async function join(code, name, hooks, { private: privately = true } = {}) {
  const secrets = await secretsFor(code);
  const cid = `c${randomId()}`;
  const reply = `${secrets.topic}/${randomId()}`;
  const fresh = dedupe();
  let via = privately ? 'relay' : 'direct';
  let signal = null;
  let pc = null;
  let ch = null;
  let welcomed = false;
  let left = false;
  let ended = false;
  let nextId = 1;
  let best = { rtt: Infinity, offset: 0 };
  let pinger = 0;
  let knocker = 0;
  let lastHeard = Date.now();
  let lastStateSeq = 0;

  const say = async (body) => signal && signal.send(secrets.topic, await seal(secrets.key, { ...body, cid, reply, mid: randomId() }));
  const send = (msg) => {
    if (via === 'relay') {
      say({ t: 'msg', data: msg });
    } else if (ch && ch.readyState === 'open') {
      try {
        ch.send(JSON.stringify(msg));
      } catch {
        /* closing */
      }
    }
  };
  const cleanup = () => {
    clearInterval(pinger);
    clearInterval(knocker);
    signal?.close();
    signal = null;
    if (pc) closePc(pc);
  };

  return new Promise((resolve, reject) => {
    let settled = false;
    let answered = false;
    let timer = 0;
    const fail = (why) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      reject(new Error(why));
    };
    const lost = () => {
      if (!settled) {
        fail('unreachable');
        return;
      }
      if (left || ended) return;
      cleanup();
      hooks.onEnd('lost');
    };
    timer = setTimeout(() => fail(answered ? 'unreachable' : 'not-found'), 25000);

    const controller = {
      private: privately,
      request(kind, data = null, label = '') {
        const id = nextId++;
        send({ t: 'req', id, kind, data, label });
        return id;
      },
      /** How far the host's clock is ahead of ours, in ms. */
      offset: () => best.offset,
      leave() {
        if (left) return;
        left = true;
        send({ t: 'bye' });
        setTimeout(cleanup, 400);
      },
    };

    // What the host says, whichever way it arrives.
    function fromHost(msg, seq = 0) {
      if (!msg || typeof msg !== 'object') return;
      lastHeard = Date.now();
      if (msg.t === 'welcome' && !welcomed) {
        welcomed = true;
        settled = true;
        clearTimeout(timer);
        clearInterval(knocker);
        // Direct guests only needed the brokers to meet; relayed ones keep them.
        if (via === 'direct') {
          signal?.close();
          signal = null;
        }
        const ping = () => {
          send({ t: 'ping', c: Date.now() });
          if (via === 'relay' && Date.now() - lastHeard > 40000) lost();
        };
        ping();
        pinger = setInterval(ping, via === 'relay' ? 10000 : 30000);
        if (Number.isFinite(msg.now)) best = { rtt: 5000, offset: msg.now - Date.now() };
        resolve(controller);
        hooks.onWelcome(msg, controller);
      } else if (!welcomed) {
        /* nothing counts before the welcome */
      } else if (msg.t === 'pong' && Number.isFinite(msg.c) && Number.isFinite(msg.h)) {
        const rtt = Date.now() - msg.c;
        // The quickest round trip involves the least guesswork, so trust it most.
        if (rtt >= 0 && rtt <= best.rtt * 1.5) best = { rtt: Math.min(rtt, best.rtt), offset: msg.h - (msg.c + rtt / 2) };
      } else if (msg.t === 'state' && msg.state && typeof msg.state === 'object') {
        // Relayed messages can arrive out of order; never go back to an older state.
        if (seq && seq < lastStateSeq) return;
        if (seq) lastStateSeq = seq;
        hooks.onState(msg.state);
      } else if (msg.t === 'members' && Array.isArray(msg.members)) {
        hooks.onMembers(msg.members.slice(0, MAX_GUESTS + 1).map((x) => ({ id: str(x && x.id, 64), name: str(x && x.name, 24) || 'Guest', host: Boolean(x && x.host), role: str(x && x.role, 12) })));
      } else if (msg.t === 'access' && msg.access && typeof msg.access === 'object') {
        if (hooks.onAccess) hooks.onAccess(msg.access);
      } else if (msg.t === 'ans') {
        const wait = Number(msg.wait);
        hooks.onAnswer({ id: Number(msg.id) || 0, ok: Boolean(msg.ok), text: str(msg.text, 140), auto: Boolean(msg.auto), wait: Number.isFinite(wait) ? Math.min(Math.max(wait, 0), 600000) : 0 });
      } else if (msg.t === 'end') {
        ended = true;
        cleanup();
        hooks.onEnd(msg.why === 'removed' ? 'removed' : 'ended');
      }
    }

    // Private: knock (with our name) until the host lets us in.
    const knockRelay = () => {
      via = 'relay';
      if (pc) closePc(pc);
      pc = null;
      clearInterval(knocker);
      const knock = () => !welcomed && say({ t: 'knock', name, v: PROTOCOL });
      knock();
      knocker = setInterval(knock, 3000);
    };

    const onMessage = async (topic, text) => {
      if (topic !== reply || ended) return;
      const body = await open(secrets.key, text);
      if (!body || body.cid !== cid || !fresh(body.mid)) return;
      if (body.t === 'msg') {
        fromHost(body.data, Number(body.seq) || 0);
      } else if (body.t === 'full') {
        fail('full');
      } else if (body.t === 'removed') {
        fail('removed');
      } else if (body.t === 'relay' && via === 'direct' && !answered) {
        // The host keeps the party private: come in through the relay instead.
        knockRelay();
      } else if (body.t === 'answer' && body.sdp && via === 'direct' && !answered) {
        answered = true;
        clearInterval(knocker);
        try {
          await pc.setRemoteDescription(body.sdp);
        } catch {
          fail('unreachable');
        }
      }
    };

    (async () => {
      signal = await openSignal([reply], onMessage);
      if (via === 'relay') {
        knockRelay();
        return;
      }
      pc = newPeer(false, (state) => {
        if (state === 'failed' || state === 'closed') lost();
      });
      ch = pc.createDataChannel('party', { ordered: true });
      ch.onopen = () => send({ t: 'hello', v: PROTOCOL, name });
      ch.onclose = () => via === 'direct' && lost();
      ch.onmessage = (e) => {
        try {
          fromHost(JSON.parse(e.data));
        } catch {
          /* not for us */
        }
      };
      await pc.setLocalDescription(await pc.createOffer());
      await gathered(pc, false);
      if (via !== 'direct') return;
      const offer = { t: 'offer', sdp: shareable(pc, false) };
      const knock = () => !answered && via === 'direct' && say(offer);
      knock();
      knocker = setInterval(knock, 3000);
    })().catch((err) => fail(err && /^network/.test(err.message) ? err.message : `setup:${(err && (err.name || err.message)) || 'error'}`));
  });
}

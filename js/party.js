// Focus parties: a host and guests sharing one session in real time.
//
// Devices connect to each other with WebRTC data channels. To find each other
// they need a small relay for the opening handshake ("signaling"); we speak
// the simple WebSocket protocol of the free public PeerJS server.
//
// Privacy, by design:
// - The party code never leaves your device. The relay only sees a one-way
//   hash of it as the host's name.
// - Everything sent through the relay (the connection offers, which would
//   otherwise contain network addresses) is end-to-end encrypted with AES-GCM
//   under a key derived from the code with 200,000 rounds of PBKDF2. Without
//   the code it can't be read or forged, and guessing codes is slow.
// - "Private" connections (the default) go through a TURN relay only, so
//   party members never learn each other's IP addresses. The relay forwards
//   traffic it can't read: WebRTC encrypts it (DTLS) from end to end.
// - Like any server you connect to, the relays themselves see the address
//   that connects to them, but not who you're talking to or what you say.
//
// The host's tab is the source of truth: guests receive its state and send
// requests, and the host decides what happens.

const DEFAULT_SIGNAL = { url: 'wss://0.peerjs.com/peerjs', key: 'peerjs' };
const STUN = { urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] };
// PeerJS's public TURN relay (plain UDP/TCP and TLS on 443 for strict networks).
const TURN = {
  urls: ['turn:eu-0.turn.peerjs.com:3478', 'turn:us-0.turn.peerjs.com:3478', 'turn:eu-0.turn.peerjs.com:3478?transport=tcp', 'turns:eu-0.turn.peerjs.com:443?transport=tcp'],
  username: 'peerjs',
  credential: 'peerjsp',
};
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I/L
export const CODE_LENGTH = 8;
export const MAX_GUESTS = 12;
const PROTOCOL = 1;
const REQUEST_KINDS = ['toggle', 'skip', 'reset', 'mode', 'more', 'sound', 'mix', 'task', 'done', 'message', 'break'];

export const supported =
  typeof RTCPeerConnection === 'function' && typeof WebSocket === 'function' && Boolean(globalThis.crypto && crypto.subtle);

const enc = new TextEncoder();
const dec = new TextDecoder();
const hex = (buf) => [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, '0')).join('');
const randomId = () => hex(crypto.getRandomValues(new Uint8Array(8)));
const b64 = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64 = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

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

/** The host's public name (a hash of the code) and the shared secret key. */
async function secretsFor(code) {
  const id = `tempo-${hex(await crypto.subtle.digest('SHA-256', enc.encode(`tempo-party/id/${code}`))).slice(0, 32)}`;
  const base = await crypto.subtle.importKey('raw', enc.encode(code), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: enc.encode('tempo-party/key/v1'), iterations: 200000, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
  return { id, key };
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

// Tests (and anyone self-hosting) can point at other servers.
function config() {
  try {
    const raw = JSON.parse(localStorage.getItem('tempo:signal') || 'null');
    if (raw && /^wss?:\/\//.test(raw.url) && typeof raw.key === 'string') return { ...DEFAULT_SIGNAL, ...raw };
  } catch {
    /* use the defaults */
  }
  return DEFAULT_SIGNAL;
}

function iceConfig(privately) {
  const custom = config().iceServers;
  const iceServers = Array.isArray(custom) ? custom : privately ? [TURN] : [STUN, TURN];
  // Private: only relayed routes, so no device's own address is ever offered.
  return { iceServers, iceTransportPolicy: privately ? 'relay' : 'all' };
}

/** Connect to the signaling relay under `id`. Resolves once it's ready. */
function openSignal(id, { onMessage, onClose }) {
  return new Promise((resolve, reject) => {
    const { url, key } = config();
    let ws;
    try {
      ws = new WebSocket(`${url}?key=${encodeURIComponent(key)}&id=${encodeURIComponent(id)}&token=${randomId()}`);
    } catch (err) {
      reject(new Error(`network:blocked (${err && err.name})`));
      return;
    }
    let opened = false;
    let closed = false;
    const heartbeat = setInterval(() => {
      if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'HEARTBEAT' }));
    }, 5000);
    const api = {
      send(type, dst, box) {
        if (ws.readyState === 1) ws.send(JSON.stringify({ type, dst, payload: { box } }));
      },
      close() {
        closed = true;
        clearInterval(heartbeat);
        try {
          ws.close();
        } catch {
          /* already closed */
        }
      },
    };
    // Slow mobile networks can take a while to say hello.
    const timeout = setTimeout(() => {
      if (opened) return;
      reject(new Error('network:timeout'));
      api.close();
    }, 20000);
    ws.onmessage = (e) => {
      let m;
      try {
        m = JSON.parse(e.data);
      } catch {
        return;
      }
      if (!m || typeof m !== 'object') return;
      if (m.type === 'OPEN') {
        opened = true;
        clearTimeout(timeout);
        resolve(api);
      } else if (m.type === 'ID-TAKEN' || m.type === 'INVALID-KEY' || m.type === 'ERROR') {
        if (!opened) {
          clearTimeout(timeout);
          reject(new Error(m.type === 'ID-TAKEN' ? 'taken' : `network:server (${str(m.payload && m.payload.msg, 80) || m.type})`));
          api.close();
        }
      } else {
        onMessage(m);
      }
    };
    ws.onerror = () => {
      if (!opened) {
        clearTimeout(timeout);
        reject(new Error('network:error'));
      }
    };
    ws.onclose = (e) => {
      clearInterval(heartbeat);
      if (!opened) {
        clearTimeout(timeout);
        reject(new Error(`network:closed (${e.code})`));
      } else if (!closed) {
        onClose();
      }
    };
  });
}

/** openSignal, trying again a couple of times if the network hiccups. */
async function openSignalRetry(id, handlers, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      return await openSignal(id, handlers);
    } catch (err) {
      last = err;
      if (err.message === 'taken') throw err;
      await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
    }
  }
  throw last;
}

/** An RTCPeerConnection that trickles its (sealed) candidates through the relay. */
function peerLink(privately, sendSealed, onState) {
  const pc = new RTCPeerConnection(iceConfig(privately));
  const early = []; // candidates that arrive before the remote description
  pc.onicecandidate = (e) => {
    if (!e.candidate) return;
    // Belt and braces: in private mode never pass on anything but relays.
    if (privately && e.candidate.type && e.candidate.type !== 'relay') return;
    sendSealed('CANDIDATE', { candidate: e.candidate.toJSON() });
  };
  pc.onconnectionstatechange = () => onState(pc.connectionState);
  return {
    pc,
    async addCandidate(c) {
      if (!c || typeof c !== 'object') return;
      if (pc.remoteDescription) await pc.addIceCandidate(c).catch(() => {});
      else early.push(c);
    },
    async flush() {
      for (const c of early.splice(0)) await pc.addIceCandidate(c).catch(() => {});
    },
    close() {
      try {
        pc.close();
      } catch {
        /* already closed */
      }
    },
  };
}

const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/**
 * Start hosting. Resolves with { code, broadcast(state), answer(guestId, reqId, ok, text),
 * members(), end() } once the party can be joined.
 *
 * hooks: getState() → the state to share; onJoin(guest), onLeave(guest),
 * onRequest(guest, request), onSignal(online) when the relay drops or returns.
 * opts: { private: true } to keep everyone's IP address hidden (the default).
 */
export async function host(name, hooks, { private: privately = true } = {}) {
  const guests = new Map(); // connection id → guest
  let signal = null;
  let ended = false;
  let code = '';
  let secrets = null;

  const send = (g, msg) => {
    if (g.ch && g.ch.readyState === 'open') {
      try {
        g.ch.send(JSON.stringify(msg));
      } catch {
        /* closing */
      }
    }
  };
  const memberList = () => [
    { id: 'host', name, host: true },
    ...[...guests.values()].filter((g) => g.ready).map((g) => ({ id: g.id, name: g.name })),
  ];
  const sendMembers = () => {
    const members = memberList();
    guests.forEach((g) => g.ready && send(g, { t: 'members', members }));
  };
  const relay = async (type, dst, body) => signal?.send(type, dst, await seal(secrets.key, body));

  function drop(g) {
    if (guests.get(g.id) !== g) return;
    guests.delete(g.id);
    g.link.close();
    if (g.ready && !ended) {
      hooks.onLeave(g);
      sendMembers();
    }
  }

  function attach(g, ch) {
    g.ch = ch;
    ch.onmessage = (e) => {
      let m;
      try {
        m = JSON.parse(e.data);
      } catch {
        return;
      }
      if (!m || typeof m !== 'object') return;
      if (m.t === 'hello' && !g.ready) {
        g.name = str(m.name, 24) || 'Guest';
        g.ready = true;
        send(g, { t: 'welcome', id: g.id, host: name, state: hooks.getState(), members: memberList(), now: Date.now() });
        hooks.onJoin(g);
        sendMembers();
      } else if (m.t === 'ping') {
        send(g, { t: 'pong', c: m.c, h: Date.now() });
      } else if (m.t === 'req' && g.ready && REQUEST_KINDS.includes(m.kind)) {
        hooks.onRequest(g, { id: Number(m.id) || 0, kind: m.kind, data: m.data ?? null, label: str(m.label, 140) });
      } else if (m.t === 'bye') {
        drop(g);
      }
    };
    ch.onclose = () => drop(g);
  }

  async function onMessage(m) {
    if (ended || !m.src || !m.payload) return;
    const body = await open(secrets.key, m.payload.box);
    if (!body) return; // not someone with the code
    const cid = str(body.cid, 64);
    if (!cid) return;
    try {
      if (m.type === 'OFFER') {
        if (guests.has(cid)) return;
        if (guests.size >= MAX_GUESTS) {
          await relay('ANSWER', m.src, { cid, full: true });
          return;
        }
        const g = { id: cid, peer: m.src, name: 'Guest', ready: false };
        g.link = peerLink(privately, (type, extra) => relay(type, m.src, { cid, ...extra }), (s) => {
          if (s === 'failed' || s === 'closed') drop(g);
        });
        guests.set(cid, g);
        g.link.pc.ondatachannel = (e) => attach(g, e.channel);
        await g.link.pc.setRemoteDescription(body.sdp);
        await g.link.flush();
        await g.link.pc.setLocalDescription(await g.link.pc.createAnswer());
        await relay('ANSWER', m.src, { cid, sdp: g.link.pc.localDescription.toJSON() });
        // Someone who knocks but never finishes joining is let go.
        setTimeout(() => {
          if (!g.ready) drop(g);
        }, 30000);
      } else if (m.type === 'CANDIDATE') {
        await guests.get(cid)?.link.addCandidate(body.candidate);
      }
    } catch {
      const g = guests.get(cid);
      if (g) drop(g);
    }
  }

  // Keep the relay connection open so new guests can find us; if it drops,
  // guests already here stay connected while we quietly reconnect.
  const connect = async () => {
    signal = await openSignalRetry(secrets.id, { onMessage, onClose: reconnect });
  };
  let retry = 0;
  let reconnecting = false;
  function reconnect(delay = 1500) {
    signal = null;
    if (ended || reconnecting) return;
    reconnecting = true;
    hooks.onSignal(false);
    clearTimeout(retry);
    retry = setTimeout(async () => {
      try {
        await connect();
        reconnecting = false;
        hooks.onSignal(true);
      } catch {
        reconnecting = false;
        reconnect(4000);
      }
    }, delay);
  }
  // Phones pause pages in the background, which drops the relay connection;
  // reconnect the moment the host comes back so guests can find the party.
  const onVisible = () => {
    if (!document.hidden && !signal && !ended) {
      reconnecting = false;
      reconnect(0);
    }
  };
  document.addEventListener('visibilitychange', onVisible);

  for (let tries = 0; tries < 4 && !signal; tries++) {
    code = makeCode();
    secrets = await secretsFor(code);
    try {
      await connect();
    } catch (err) {
      if (err.message !== 'taken') throw err;
    }
  }
  if (!signal) throw new Error('network');

  // Guests get the full state now and then anyway, to correct any drift.
  const heartbeat = setInterval(() => controller.broadcast(hooks.getState()), 15000);

  const controller = {
    code,
    private: privately,
    members: memberList,
    broadcast(state) {
      const msg = { t: 'state', state, now: Date.now() };
      guests.forEach((g) => g.ready && send(g, msg));
    },
    answer(guestId, reqId, ok, text = '') {
      const g = guests.get(guestId);
      if (g) send(g, { t: 'ans', id: reqId, ok: Boolean(ok), text: str(text, 140) });
    },
    end() {
      if (ended) return;
      ended = true;
      clearInterval(heartbeat);
      clearTimeout(retry);
      document.removeEventListener('visibilitychange', onVisible);
      guests.forEach((g) => {
        send(g, { t: 'end' });
        // Give the goodbye a moment to arrive before hanging up.
        setTimeout(() => g.link.close(), 400);
      });
      guests.clear();
      signal?.close();
    },
  };
  return controller;
}

/**
 * Join the party with this code. Resolves with { request(kind, data, label),
 * offset(), leave() } once the host has welcomed us.
 *
 * hooks: onWelcome(msg), onState(state), onMembers(list), onAnswer(answer),
 * onEnd(reason) where reason is 'ended' (the host closed it) or 'lost'.
 * Rejects with Error('not-found' | 'full' | 'unreachable' | 'network').
 */
export async function join(code, name, hooks, { private: privately = true } = {}) {
  const secrets = await secretsFor(code);
  const cid = `c${randomId()}`;
  let signal = null;
  let link = null;
  let ch = null;
  let welcomed = false;
  let left = false;
  let ended = false;
  let nextId = 1;
  let best = { rtt: Infinity, offset: 0 };
  let pinger = 0;

  const send = (msg) => {
    if (ch && ch.readyState === 'open') {
      try {
        ch.send(JSON.stringify(msg));
      } catch {
        /* closing */
      }
    }
  };
  const relay = async (type, body) => signal?.send(type, secrets.id, await seal(secrets.key, { cid, ...body }));
  const cleanup = () => {
    clearInterval(pinger);
    signal?.close();
    signal = null;
    link?.close();
  };

  return new Promise((resolve, reject) => {
    let settled = false;
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
    const timer = setTimeout(() => fail('unreachable'), 45000);

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
        setTimeout(cleanup, 200);
      },
    };

    // If the host is briefly away (a phone switching apps), knock again.
    let offerBody = null;
    let knocks = 0;
    const knock = () => relay('OFFER', offerBody);
    const onMessage = async (m) => {
      if (m.type === 'EXPIRE') {
        if (knocks < 4 && offerBody) {
          knocks += 1;
          setTimeout(() => !settled && knock(), 2500);
        } else {
          fail('not-found');
        }
        return;
      }
      if (!m.payload) return;
      const body = await open(secrets.key, m.payload.box);
      if (!body || body.cid !== cid) return;
      try {
        if (m.type === 'ANSWER') {
          if (body.full) {
            fail('full');
            return;
          }
          await link.pc.setRemoteDescription(body.sdp);
          await link.flush();
        } else if (m.type === 'CANDIDATE') {
          await link.addCandidate(body.candidate);
        }
      } catch {
        fail('unreachable');
      }
    };

    openSignalRetry(`tempo-guest-${randomId()}`, { onMessage, onClose: () => { if (!settled) fail('network:closed'); } })
      .then(async (s) => {
        signal = s;
        link = peerLink(privately, (type, extra) => relay(type, extra), (state) => {
          if (state === 'failed' || state === 'closed') lost();
        });
        ch = link.pc.createDataChannel('party', { ordered: true });
        ch.onopen = () => send({ t: 'hello', v: PROTOCOL, name });
        ch.onclose = lost;
        ch.onmessage = (e) => {
          let msg;
          try {
            msg = JSON.parse(e.data);
          } catch {
            return;
          }
          if (!msg || typeof msg !== 'object') return;
          if (msg.t === 'welcome' && !welcomed) {
            welcomed = true;
            settled = true;
            clearTimeout(timer);
            // The relay is only needed to meet; let it go.
            signal?.close();
            signal = null;
            const ping = () => send({ t: 'ping', c: Date.now() });
            ping();
            pinger = setInterval(ping, 30000);
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
            hooks.onState(msg.state);
          } else if (msg.t === 'members' && Array.isArray(msg.members)) {
            hooks.onMembers(msg.members.slice(0, MAX_GUESTS + 1).map((x) => ({ id: str(x && x.id, 64), name: str(x && x.name, 24) || 'Guest', host: Boolean(x && x.host) })));
          } else if (msg.t === 'ans') {
            hooks.onAnswer({ id: Number(msg.id) || 0, ok: Boolean(msg.ok), text: str(msg.text, 140) });
          } else if (msg.t === 'end') {
            ended = true;
            cleanup();
            hooks.onEnd('ended');
          }
        };
        await link.pc.setLocalDescription(await link.pc.createOffer());
        offerBody = { sdp: link.pc.localDescription.toJSON() };
        await knock();
      })
      .catch((err) => fail(err && /^network/.test(err.message) ? err.message : `setup:${err && (err.name || err.message)}`));
  });
}

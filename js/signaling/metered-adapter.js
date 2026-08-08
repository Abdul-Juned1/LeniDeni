// ---------------------------------------------------------------------------
// Metered Open Relay signaling adapter.
//
// IMPORTANT — read before shipping:
// This wraps @metered-ca/realtime, loaded from esm.sh so there's no build
// step. The join/presence/direct-message calls below (peer.join, "peer-joined",
// peer.send, "message") match Metered's published docs and examples as of
// this writing, but third-party SDK surfaces do shift between versions.
// Before relying on this in anything real: open
//   https://www.metered.ca/docs/realtime-messaging/sdk-javascript
// and confirm the direct-message method name and payload shape still match
// what's used in sendSignal()/onSignal() below. Everything is funnelled
// through those two functions specifically so a version mismatch is a
// one-function fix, not a rewrite.
//
// Deliberate design choice: we use Metered ONLY to exchange SDP/ICE (the
// signaling problem). We do NOT use its high-level addStream()/data-channel
// helpers for the actual file transfer — transport.js needs a raw
// RTCDataChannel with { ordered: false } and no reliability caps, which is
// a level of control the high-level API doesn't expose. See webrtc.js.
// ---------------------------------------------------------------------------

import { CONFIG } from '../config.js';

let MeteredPeerCtor = null;
async function loadSdk() {
  if (MeteredPeerCtor) return MeteredPeerCtor;
  const mod = await import('https://esm.sh/@metered-ca/realtime@latest');
  console.log('[metered] raw module export keys:', Object.keys(mod));
  MeteredPeerCtor = mod.MeteredPeer ?? mod.default?.MeteredPeer ?? mod.default;
  return MeteredPeerCtor;
}

export class MeteredSignaling {
  constructor() {
    this.peer = null;
    this.roomCode = null;
    this._peerJoinedCb = () => {};
    this._peerLeftCb = () => {};
    this._signalCb = () => {};
    this._knownIceServers = null;
  }

  async connect(roomCode) {
    console.log('[metered] loading SDK…');
    const MeteredPeer = await loadSdk();
    console.log('[metered] SDK loaded, MeteredPeer =', MeteredPeer);
    if (typeof MeteredPeer !== 'function') {
      console.error('[metered] MeteredPeer export is not a constructor — the esm.sh import likely resolved the wrong export shape. Check what `mod` actually contains (see console.log above loadSdk()\'s return).');
    }

    this.roomCode = roomCode;
    this.peer = new MeteredPeer({ apiKey: CONFIG.METERED.API_KEY });
    console.log('[metered] peer instance created', this.peer);

    // Presence: another browser joining the same room code is our peer.
    this.peer.on('peer-joined', (payload) => {
      console.log('[metered] event: peer-joined', payload);
      const remote = payload?.peer ?? payload;
      this._peerJoinedCb(remote?.id ?? remote?.peerId ?? remote);
    });
    this.peer.on('peer-left', (payload) => {
      console.log('[metered] event: peer-left', payload);
      const remote = payload?.peer ?? payload;
      this._peerLeftCb(remote?.id ?? remote?.peerId ?? remote);
    });

    // Direct/room messages carrying our own SDP+ICE envelopes.
    // Adapter point — see file header if this event/shape has moved on.
    this.peer.on('message', (msg) => {
      console.log('[metered] event: message', msg);
      const from = msg.from ?? msg.peerId ?? msg.sender;
      const body = msg.body ?? msg.data ?? msg;
      if (from && body && body.__p2phs) this._signalCb(from, body.payload);
    });

    // Capture TURN creds if the SDK surfaces them directly on connect.
    this.peer.on('ready', (info) => {
      console.log('[metered] event: ready', info);
      if (info?.iceServers) this._knownIceServers = info.iceServers;
    });

    // Log literally every event the emitter fires, if it exposes a
    // wildcard/onAny hook — harmless no-op if it doesn't.
    try { this.peer.onAny?.((event, ...args) => console.log('[metered] event(onAny):', event, args)); } catch { /* not supported */ }

    console.log('[metered] calling peer.join(', roomCode, ')…');
    try {
      const joinResult = await this.peer.join(roomCode);
      console.log('[metered] peer.join() resolved with', joinResult);
    } catch (err) {
      console.error('[metered] peer.join() rejected/threw:', err);
      throw err;
    }
  }

  onPeerJoined(cb) { this._peerJoinedCb = cb; }
  onPeerLeft(cb) { this._peerLeftCb = cb; }
  onSignal(cb) { this._signalCb = cb; }

  async sendSignal(toPeerId, data) {
    // Wrapped so our own signal envelopes are distinguishable from anything
    // else flowing over the same channel (presence pings, etc).
    await this.peer.send(toPeerId, { __p2phs: true, payload: data });
  }

  async getIceServers() {
    if (this._knownIceServers?.length) return this._knownIceServers;

    // Confirmed-stable REST fallback: Metered's TURN credentials endpoint.
    // This always works even if the SDK never surfaces creds directly.
    try {
      const { TURN_REST_URL, TURN_REST_API_KEY } = CONFIG.METERED;
      const res = await fetch(`${TURN_REST_URL}?apiKey=${encodeURIComponent(TURN_REST_API_KEY)}`);
      if (res.ok) {
        const servers = await res.json();
        if (Array.isArray(servers) && servers.length) return servers;
      }
    } catch (err) {
      console.warn('[signaling] Metered TURN REST fetch failed, STUN-only will be used', err);
    }
    return [];
  }

  disconnect() {
    try { this.peer?.leave?.(this.roomCode); } catch { /* best-effort */ }
    try { this.peer?.close?.(); } catch { /* best-effort */ }
  }
}
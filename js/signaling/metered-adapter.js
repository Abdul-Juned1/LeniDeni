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
  MeteredPeerCtor = mod.MeteredPeer;
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
    const MeteredPeer = await loadSdk();
    this.roomCode = roomCode;

    this.peer = new MeteredPeer({ apiKey: CONFIG.METERED.API_KEY });

    // Presence: another browser joining the same room code is our peer.
    this.peer.on('peer-joined', ({ peer: remote }) => {
      this._peerJoinedCb(remote.id ?? remote.peerId ?? remote);
    });
    this.peer.on('peer-left', ({ peer: remote } = {}) => {
      this._peerLeftCb(remote?.id ?? remote?.peerId ?? remote);
    });

    // Direct/room messages carrying our own SDP+ICE envelopes.
    // Adapter point — see file header if this event/shape has moved on.
    this.peer.on('message', (msg) => {
      const from = msg.from ?? msg.peerId ?? msg.sender;
      const body = msg.body ?? msg.data ?? msg;
      if (from && body && body.__p2phs) this._signalCb(from, body.payload);
    });

    // Capture TURN creds if the SDK surfaces them directly on connect.
    this.peer.on('ready', (info) => {
      if (info?.iceServers) this._knownIceServers = info.iceServers;
    });

    await this.peer.join(roomCode);
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

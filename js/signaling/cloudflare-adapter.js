// ---------------------------------------------------------------------------
// Cloudflare Workers + Durable Objects signaling adapter.
//
// This is the "learning exercise" fallback: a tiny WebSocket relay you deploy
// yourself (see /cf-worker). Since it's our own protocol end to end, there's
// no third-party SDK surface to guess at here — this file and cf-worker/src
// must simply agree with each other, and they do.
//
// Same public interface as metered-adapter.js so app.js can swap backends
// via CONFIG.SIGNALING_BACKEND without touching anything else.
// ---------------------------------------------------------------------------

import { CONFIG } from '../config.js';

export class CloudflareSignaling {
  constructor() {
    this.ws = null;
    this.selfId = null;
    this._peerJoinedCb = () => {};
    this._peerLeftCb = () => {};
    this._signalCb = () => {};
  }

  connect(roomCode) {
    return new Promise((resolve, reject) => {
      const url = `${CONFIG.CLOUDFLARE_SIGNALING.WS_URL}/room/${encodeURIComponent(roomCode)}`;
      this.ws = new WebSocket(url);

      this.ws.addEventListener('open', () => resolve());
      this.ws.addEventListener('error', (e) => reject(e));

      this.ws.addEventListener('message', (event) => {
        let msg;
        try { msg = JSON.parse(event.data); } catch { return; }

        switch (msg.type) {
          case 'welcome':
            this.selfId = msg.selfId;
            break;
          case 'peer-joined':
            this._peerJoinedCb(msg.peerId);
            break;
          case 'peer-left':
            this._peerLeftCb(msg.peerId);
            break;
          case 'signal':
            this._signalCb(msg.from, msg.payload);
            break;
        }
      });

      this.ws.addEventListener('close', () => {
        this._peerLeftCb(null);
      });
    });
  }

  onPeerJoined(cb) { this._peerJoinedCb = cb; }
  onPeerLeft(cb) { this._peerLeftCb = cb; }
  onSignal(cb) { this._signalCb = cb; }

  async sendSignal(toPeerId, data) {
    this.ws.send(JSON.stringify({ type: 'signal', to: toPeerId, payload: data }));
  }

  async getIceServers() {
    // Cloudflare Realtime TURN issues short-lived credentials server-side.
    // The worker mints them on join and pushes them down as a "turn-creds"
    // message so the secret Turn Key ID/API token never reaches the browser.
    return new Promise((resolve) => {
      const handler = (event) => {
        let msg;
        try { msg = JSON.parse(event.data); } catch { return; }
        if (msg.type === 'turn-creds') {
          this.ws.removeEventListener('message', handler);
          resolve(msg.iceServers || []);
        }
      };
      this.ws.addEventListener('message', handler);
      this.ws.send(JSON.stringify({ type: 'request-turn-creds' }));
      // Don't block forever if the worker has no TURN configured yet.
      setTimeout(() => resolve([]), 3000);
    });
  }

  disconnect() {
    try { this.ws?.close(); } catch { /* best-effort */ }
  }
}

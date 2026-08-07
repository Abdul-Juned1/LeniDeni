// ---------------------------------------------------------------------------
// Cloudflare Worker + Durable Object signaling relay.
//
// One Durable Object instance per room code (idFromName(roomCode)) holds the
// WebSocket connections for whoever's in that room and relays SDP/ICE
// messages between them — this is the entire job of a signaling server.
// Durable Objects run free-of-commitment on the Workers Free plan (SQLite
// storage backend, which this doesn't even need since state is just the
// live socket list — nothing is persisted to storage at all).
//
// This file matches js/signaling/cloudflare-adapter.js message-for-message:
// they're our own protocol, so there's nothing to "get wrong" against a
// third party's docs the way the Metered integration has to guess at.
// ---------------------------------------------------------------------------

import { DurableObject } from 'cloudflare:workers';

export class RoomSignaling extends DurableObject {
  constructor(state, env) {
    super(state, env);
    this.sockets = new Map(); // peerId -> WebSocket
  }

  async fetch(request) {
    const upgrade = request.headers.get('Upgrade');
    if (upgrade !== 'websocket') return new Response('Expected WebSocket', { status: 426 });

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();

    const peerId = crypto.randomUUID();
    this.sockets.set(peerId, server);
    server.send(JSON.stringify({ type: 'welcome', selfId: peerId }));

    // Tell existing peers about the newcomer, and the newcomer about them.
    for (const [otherId, otherWs] of this.sockets) {
      if (otherId === peerId) continue;
      otherWs.send(JSON.stringify({ type: 'peer-joined', peerId }));
      server.send(JSON.stringify({ type: 'peer-joined', peerId: otherId }));
    }

    server.addEventListener('message', (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }

      if (msg.type === 'signal' && msg.to) {
        this.sockets.get(msg.to)?.send(JSON.stringify({ type: 'signal', from: peerId, payload: msg.payload }));
      } else if (msg.type === 'request-turn-creds') {
        this._sendTurnCreds(server);
      }
    });

    const cleanup = () => {
      this.sockets.delete(peerId);
      for (const ws of this.sockets.values()) {
        ws.send(JSON.stringify({ type: 'peer-left', peerId }));
      }
    };
    server.addEventListener('close', cleanup);
    server.addEventListener('error', cleanup);

    return new Response(null, { status: 101, webSocket: client });
  }

  async _sendTurnCreds(ws) {
    // Cloudflare Realtime TURN: mint short-lived credentials server-side so
    // the long-lived Turn Key ID/API token never reaches the browser.
    // Requires CF_TURN_KEY_ID / CF_TURN_API_TOKEN as Worker secrets
    // (`wrangler secret put CF_TURN_KEY_ID`, etc). If unset, we just fall
    // back to STUN-only — the app still works on non-symmetric-NAT networks.
    if (!this.env.CF_TURN_KEY_ID || !this.env.CF_TURN_API_TOKEN) {
      return ws.send(JSON.stringify({ type: 'turn-creds', iceServers: [] }));
    }
    try {
      const res = await fetch(
        `https://rtc.live.cloudflare.com/v1/turn/keys/${this.env.CF_TURN_KEY_ID}/credentials/generate-ice-servers`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.env.CF_TURN_API_TOKEN}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ ttl: 86400 }),
        },
      );
      const data = await res.json();
      ws.send(JSON.stringify({ type: 'turn-creds', iceServers: data.iceServers ?? [] }));
    } catch (err) {
      ws.send(JSON.stringify({ type: 'turn-creds', iceServers: [] }));
    }
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const match = url.pathname.match(/^\/room\/([^/]+)$/);
    if (!match) return new Response('Not found', { status: 404 });

    const roomCode = decodeURIComponent(match[1]);
    const id = env.ROOM_SIGNALING.idFromName(roomCode);
    const stub = env.ROOM_SIGNALING.get(id);
    return stub.fetch(request);
  },
};

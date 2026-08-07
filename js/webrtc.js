// ---------------------------------------------------------------------------
// Raw WebRTC layer. Signaling (Metered or Cloudflare) only ever carries SDP
// and ICE candidates through here — the actual bytes never touch it.
//
// The data channel is created with { ordered: false } and no
// maxRetransmits/maxPacketLifeTime: SCTP still guarantees every chunk
// eventually arrives, it just stops enforcing arrival order, which is what
// removes head-of-line blocking and is the whole point of the "speed" USP.
// ---------------------------------------------------------------------------

import { CONFIG } from './config.js';

export class PeerLink extends EventTarget {
  /**
   * @param {object} signaling  - adapter from js/signaling/index.js, already connected
   * @param {string} peerId     - the remote peer's id from onPeerJoined
   * @param {boolean} isInitiator - room creator = true, joiner = false
   */
  constructor(signaling, peerId, isInitiator) {
    super();
    this.signaling = signaling;
    this.peerId = peerId;
    this.isInitiator = isInitiator;
    // Perfect-negotiation "polite" peer yields on glare; joiner is polite.
    this.polite = !isInitiator;
    this.makingOffer = false;
    this.ignoreOffer = false;

    this.pc = null;
    this.channel = null;
    this._statsTimer = null;
  }

  async open() {
    const iceServers = [...CONFIG.PUBLIC_STUN, ...(await this.signaling.getIceServers())];
    this.pc = new RTCPeerConnection({ iceServers });

    this.pc.addEventListener('icecandidate', ({ candidate }) => {
      if (candidate) this.signaling.sendSignal(this.peerId, { kind: 'ice', candidate });
    });

    this.pc.addEventListener('negotiationneeded', async () => {
      try {
        this.makingOffer = true;
        await this.pc.setLocalDescription();
        this.signaling.sendSignal(this.peerId, { kind: 'sdp', description: this.pc.localDescription });
      } catch (err) {
        console.error('[webrtc] negotiation failed', err);
      } finally {
        this.makingOffer = false;
      }
    });

    this.pc.addEventListener('connectionstatechange', () => {
      this.dispatchEvent(new CustomEvent('state', { detail: this.pc.connectionState }));
      if (this.pc.connectionState === 'connected') this._startStatsLoop();
      if (['disconnected', 'failed', 'closed'].includes(this.pc.connectionState)) this._stopStatsLoop();
    });

    this.signaling.onSignal((from, payload) => {
      if (from !== this.peerId) return;
      this._handleSignal(payload).catch((err) => console.error('[webrtc] signal handling failed', err));
    });

    if (this.isInitiator) {
      // Our own reliable-but-unordered channel — this is the transport, not
      // Metered's/Cloudflare's own data-channel helpers.
      this.channel = this._wireChannel(this.pc.createDataChannel('file-transfer', { ordered: false }));
    } else {
      this.pc.addEventListener('datachannel', ({ channel }) => {
        this.channel = this._wireChannel(channel);
      });
    }
  }

  async _handleSignal(payload) {
    if (payload.kind === 'sdp') {
      const desc = payload.description;
      const offerCollision = desc.type === 'offer' && (this.makingOffer || this.pc.signalingState !== 'stable');
      this.ignoreOffer = !this.polite && offerCollision;
      if (this.ignoreOffer) return;

      await this.pc.setRemoteDescription(desc);
      if (desc.type === 'offer') {
        await this.pc.setLocalDescription();
        this.signaling.sendSignal(this.peerId, { kind: 'sdp', description: this.pc.localDescription });
      }
    } else if (payload.kind === 'ice') {
      try {
        await this.pc.addIceCandidate(payload.candidate);
      } catch (err) {
        if (!this.ignoreOffer) throw err;
      }
    }
  }

  _wireChannel(channel) {
    channel.binaryType = 'arraybuffer';
    channel.bufferedAmountLowThreshold = CONFIG.TRANSPORT.BUFFERED_AMOUNT_LOW;

    channel.addEventListener('open', () => this.dispatchEvent(new CustomEvent('channel-open')));
    channel.addEventListener('close', () => this.dispatchEvent(new CustomEvent('channel-close')));
    channel.addEventListener('bufferedamountlow', () => this.dispatchEvent(new CustomEvent('drain')));
    channel.addEventListener('message', (e) => this.dispatchEvent(new CustomEvent('data', { detail: e.data })));

    return channel;
  }

  send(arrayBufferOrView) {
    this.channel.send(arrayBufferOrView);
  }

  get bufferedAmount() {
    return this.channel?.bufferedAmount ?? 0;
  }

  /** Polls getStats() to expose the *selected* candidate pair's path type. */
  _startStatsLoop() {
    this._stopStatsLoop();
    this._statsTimer = setInterval(async () => {
      const info = await this.getActivePathInfo();
      if (info) this.dispatchEvent(new CustomEvent('path', { detail: info }));
    }, 1000);
  }
  _stopStatsLoop() {
    if (this._statsTimer) clearInterval(this._statsTimer);
    this._statsTimer = null;
  }

  async getActivePathInfo() {
    if (!this.pc) return null;
    const report = await this.pc.getStats();
    let pair = null;
    report.forEach((stat) => {
      if (stat.type === 'candidate-pair' && stat.state === 'succeeded' && (stat.nominated ?? true)) pair = stat;
    });
    if (!pair) return null;

    const local = report.get(pair.localCandidateId);
    const remote = report.get(pair.remoteCandidateId);
    return {
      localType: local?.candidateType ?? 'unknown',   // host | srflx | prflx | relay
      remoteType: remote?.candidateType ?? 'unknown',
      bytesSent: pair.bytesSent ?? 0,
      bytesReceived: pair.bytesReceived ?? 0,
    };
  }

  close() {
    this._stopStatsLoop();
    try { this.channel?.close(); } catch { /* best-effort */ }
    try { this.pc?.close(); } catch { /* best-effort */ }
  }
}

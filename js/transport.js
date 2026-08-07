// ---------------------------------------------------------------------------
// Transport: turns a PeerLink's single raw RTCDataChannel into concurrent,
// resumable, out-of-order-tolerant file transfers.
//
// Wire format:
//   - Control messages are JSON strings (RTCDataChannel sends strings and
//     ArrayBuffers over the same channel natively — no need for a second
//     channel).
//   - Chunk messages are ArrayBuffers: an 8-byte header (uint32 fileId,
//     uint32 seq, both little-endian) followed by the raw chunk bytes.
//
// Backpressure lives here, not in the workers: only the main thread can see
// channel.bufferedAmount, so this is where the "manual backpressure" the
// spec calls for is actually implemented. The sender worker is kept a fixed
// number of chunks ("credit") ahead of what's been queued into the channel,
// and credit is only replenished from the 'drain' (bufferedamountlow) event.
// ---------------------------------------------------------------------------

import { CONFIG } from './config.js';
import { extOf, isExecutableAdjacent } from './security.js';

const HEADER_BYTES = 8;

function encodeHeader(fileId, seq) {
  const buf = new ArrayBuffer(HEADER_BYTES);
  const view = new DataView(buf);
  view.setUint32(0, fileId, true);
  view.setUint32(4, seq, true);
  return buf;
}
function decodeHeader(arrayBuffer) {
  const view = new DataView(arrayBuffer, 0, HEADER_BYTES);
  return { fileId: view.getUint32(0, true), seq: view.getUint32(4, true) };
}
function concatBuffers(a, b) {
  const out = new Uint8Array(a.byteLength + b.byteLength);
  out.set(new Uint8Array(a), 0);
  out.set(new Uint8Array(b), a.byteLength);
  return out.buffer;
}

/** Steps chunk size up when the channel stays drained, down when it doesn't. */
class ChunkSizeTuner {
  constructor() {
    this.tiers = [64, 128, 256].map((kb) => kb * 1024);
    this.index = this.tiers.indexOf(CONFIG.TRANSPORT.CHUNK_SIZE_DEFAULT);
    if (this.index === -1) this.index = 1;
    this.pauseEvents = 0;
    this.samples = 0;
  }
  get size() { return this.tiers[this.index]; }
  recordPause() { this.pauseEvents++; }
  // Call roughly every ~2MB sent; adjusts tier for the *next* file only
  // (mid-file resizing would break the seq/offset math), but callers can
  // read .size before starting each new file to benefit from prior learning.
  tick() {
    this.samples++;
    if (this.samples < 8) return;
    const pauseRatio = this.pauseEvents / this.samples;
    if (pauseRatio > 0.4 && this.index > 0) this.index--;      // congesting -> smaller chunks
    else if (pauseRatio < 0.05 && this.index < this.tiers.length - 1) this.index++; // headroom -> bigger chunks
    this.pauseEvents = 0;
    this.samples = 0;
  }
}

export class TransportSession extends EventTarget {
  constructor(peerLink, saveEngine) {
    super();
    this.peerLink = peerLink;
    this.saveEngine = saveEngine;
    this.tuner = new ChunkSizeTuner();

    this.outgoing = new Map(); // fileId -> { worker, credit config, bytesSent, resolveDone }
    this.incoming = new Map(); // fileId -> { meta, receivedBytes }
    this._nextFileId = 1;

    this._bytesSentWindow = 0;
    this._bytesReceivedWindow = 0;

    peerLink.addEventListener('data', (e) => this._onChannelData(e.detail));
    peerLink.addEventListener('drain', () => this._onDrain());
    peerLink.addEventListener('path', (e) => this.dispatchEvent(new CustomEvent('path', { detail: e.detail })));

    this._throughputTimer = setInterval(() => this._sampleThroughput(), CONFIG.TRANSPORT.THROUGHPUT_SAMPLE_MS);

    this.saveEngine.addEventListener('progress', (e) => this._onSaveProgress(e.detail));
    this.saveEngine.addEventListener('complete', (e) => this._onSaveComplete(e.detail));
  }

  // ---- outbound -------------------------------------------------------
  /**
   * Kicks off analysis (magic-byte sniff + hash + VT) for a file about to be
   * sent. Does NOT send anything to the peer yet — listen for 'send-analysis'
   * and call confirmSend()/cancelOutgoing() once the UI (and, for
   * executable-adjacent types, a typed confirmation) has decided.
   */
  sendFile(file) {
    const fileId = this._nextFileId++;
    const chunkSize = this.tuner.size;

    const worker = new Worker(new URL('./workers/sender-worker.js', import.meta.url), { type: 'module' });
    const state = { worker, chunkSize, bytesSent: 0, totalChunks: 0, file, cancelled: false };
    this.outgoing.set(fileId, state);

    worker.onmessage = (e) => this._onSenderWorkerMessage(fileId, e.data);
    worker.postMessage({ cmd: 'analyze', fileId, file });

    return { cancel: () => this._cancelOutgoing(fileId), fileId };
  }

  /** Call once the sender-side security gate (if any) has been cleared. */
  confirmSend(fileId) {
    const state = this.outgoing.get(fileId);
    if (!state || !state.security) return;
    this._sendControl({
      type: 'file-offer', fileId, name: state.file.name, size: state.file.size,
      mime: state.file.type || 'application/octet-stream', chunkSize: state.chunkSize,
      security: state.security,
    });
  }

  _onSenderWorkerMessage(fileId, msg) {
    const state = this.outgoing.get(fileId);
    if (!state) return;

    if (msg.type === 'analysis') {
      state.security = { sniff: msg.sniff, sha256: msg.sha256, vt: msg.vt };
      this.dispatchEvent(new CustomEvent('send-analysis', { detail: { fileId, name: state.file.name, ...state.security } }));
    } else if (msg.type === 'meta') {
      state.totalChunks = msg.totalChunks;
    } else if (msg.type === 'chunk') {
      const header = encodeHeader(fileId, msg.seq);
      this.peerLink.send(concatBuffers(header, msg.buffer));
      state.bytesSent += msg.buffer.byteLength;
      this._bytesSentWindow += msg.buffer.byteLength;

      this.dispatchEvent(new CustomEvent('send-progress', {
        detail: { fileId, sentBytes: state.bytesSent, totalBytes: state.file.size },
      }));

      if (this.peerLink.bufferedAmount > CONFIG.TRANSPORT.BUFFERED_AMOUNT_HIGH) {
        this.tuner.recordPause();
        // Stop granting credit until 'drain' fires; worker just idles.
      } else {
        state.worker.postMessage({ cmd: 'credit', fileId, add: 1 });
      }
      this.tuner.tick();
    } else if (msg.type === 'sent-all') {
      this._sendControl({ type: 'file-fin', fileId });
      this.dispatchEvent(new CustomEvent('send-complete', { detail: { fileId } }));
      state.worker.terminate();
      this.outgoing.delete(fileId);
    } else if (msg.type === 'error') {
      this.dispatchEvent(new CustomEvent('send-error', { detail: { fileId, message: msg.message } }));
    }
  }

  _onDrain() {
    // Channel has room again — replenish every outgoing file a little.
    for (const [fileId, state] of this.outgoing) {
      state.worker.postMessage({ cmd: 'credit', fileId, add: 4 });
    }
  }

  /** Public alias — UI code (app.js) cancels through this, not the internal method name. */
  cancelSend(fileId) { this._cancelOutgoing(fileId); }

  _cancelOutgoing(fileId) {
    const state = this.outgoing.get(fileId);
    if (!state) return;
    state.worker.postMessage({ cmd: 'cancel', fileId });
    state.worker.terminate();
    this.outgoing.delete(fileId);
    this._sendControl({ type: 'file-cancel', fileId });
  }

  // ---- inbound ----------------------------------------------------------
  _onChannelData(data) {
    if (typeof data === 'string') {
      this._onControl(JSON.parse(data));
    } else {
      const { fileId, seq } = decodeHeader(data);
      const payload = data.slice(HEADER_BYTES);
      const entry = this.incoming.get(fileId);
      if (!entry) return; // chunk for a file we haven't accepted (or already finished)
      entry.receivedBytes += payload.byteLength;
      this._bytesReceivedWindow += payload.byteLength;
      this.saveEngine.write(fileId, seq, payload);
    }
  }

  _onControl(msg) {
    switch (msg.type) {
      case 'file-offer':
        this.dispatchEvent(new CustomEvent('incoming-file', { detail: msg }));
        break;
      case 'file-accept':
        this._beginSendingAfterAccept(msg.fileId, msg.resumeFromChunk ?? 0);
        break;
      case 'file-reject':
        this.dispatchEvent(new CustomEvent('send-rejected', { detail: msg }));
        this._cancelOutgoing(msg.fileId);
        break;
      case 'file-fin':
        this.saveEngine.finalize(msg.fileId);
        break;
      case 'file-cancel':
        this.saveEngine.abort(msg.fileId);
        this.incoming.delete(msg.fileId);
        this.dispatchEvent(new CustomEvent('receive-cancelled', { detail: msg }));
        break;
    }
  }

  _beginSendingAfterAccept(fileId, resumeFromChunk) {
    const state = this.outgoing.get(fileId);
    if (!state) return;
    // The worker already has the file buffered + hashed from the initial
    // analyze() call in sendFile() — no need to touch disk again.
    state.worker.postMessage({
      cmd: 'startSending', fileId, chunkSize: state.chunkSize,
      initialCredit: 8, resumeFromChunk,
    });
  }

  /** Called by the UI once it has decided to accept an incoming-file offer. */
  async acceptIncoming(fileOfferMsg) {
    const { fileId, name, mime, size, chunkSize } = fileOfferMsg;
    const totalChunks = Math.ceil(size / chunkSize) || 1;

    const resumeInfo = await this.saveEngine.checkResume(fileId, { suggestedName: name, chunkSize });
    await this.saveEngine.init(fileId, { name, mime, size, chunkSize, totalChunks });

    this.incoming.set(fileId, { meta: fileOfferMsg, receivedBytes: (resumeInfo.wholeChunks || 0) * chunkSize });

    this._sendControl({ type: 'file-accept', fileId, resumeFromChunk: resumeInfo.wholeChunks || 0 });
  }

  rejectIncoming(fileId, reason) {
    this._sendControl({ type: 'file-reject', fileId, reason });
  }

  _onSaveProgress({ fileId, receivedChunks, totalChunks }) {
    this.dispatchEvent(new CustomEvent('receive-progress', { detail: { fileId, receivedChunks, totalChunks } }));
  }

  _onSaveComplete(detail) {
    this.incoming.delete(detail.fileId);
    this.dispatchEvent(new CustomEvent('receive-complete', { detail }));
  }

  _sampleThroughput() {
    const seconds = CONFIG.TRANSPORT.THROUGHPUT_SAMPLE_MS / 1000;
    const sentMBs = this._bytesSentWindow / seconds / (1024 * 1024);
    const receivedMBs = this._bytesReceivedWindow / seconds / (1024 * 1024);
    this._bytesSentWindow = 0;
    this._bytesReceivedWindow = 0;
    this.dispatchEvent(new CustomEvent('throughput', {
      detail: { sentMBs, receivedMBs, bufferedAmount: this.peerLink.bufferedAmount, chunkSizeKB: this.tuner.size / 1024 },
    }));
  }

  destroy() {
    clearInterval(this._throughputTimer);
    for (const state of this.outgoing.values()) state.worker.terminate();
  }
}

export { extOf, isExecutableAdjacent };

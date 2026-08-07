// ---------------------------------------------------------------------------
// Dual-engine save logic, uniform interface over whichever engine applies:
//
//   Engine A (Chromium): showSaveFilePicker() + FileSystemWritableFileStream,
//     resumable via keepExistingData + positioned writes. Streams straight
//     to disk — no memory ceiling on file size.
//   Engine B (Firefox/Safari/older browsers): IndexedDB-backed chunk store,
//     reassembled to a Blob for <a download>. Bounded by available memory
//     since the final Blob is built in one shot.
//
// Both engines run their actual I/O in a worker (fs-write-worker.js /
// idb-write-worker.js) — this class just routes messages to whichever one
// is active.
// ---------------------------------------------------------------------------

export const hasFileSystemAccess = 'showSaveFilePicker' in window;

export class SaveEngine extends EventTarget {
  constructor() {
    super();
    this.engine = hasFileSystemAccess ? 'A' : 'B';
    this.worker = new Worker(
      new URL(this.engine === 'A' ? './workers/fs-write-worker.js' : './workers/idb-write-worker.js', import.meta.url),
      { type: 'module' }
    );
    this.worker.onmessage = (e) => this._handleWorkerMessage(e.data);
    this._pending = new Map(); // fileId -> resolvers for one-shot request/response messages
  }

  _handleWorkerMessage(msg) {
    if (msg.type === 'progress') {
      this.dispatchEvent(new CustomEvent('progress', { detail: msg }));
    } else if (msg.type === 'complete') {
      this.dispatchEvent(new CustomEvent('complete', { detail: msg }));
    } else if (msg.type === 'error') {
      this.dispatchEvent(new CustomEvent('error', { detail: msg }));
    } else {
      const resolver = this._pending.get(`${msg.type}:${msg.fileId}`);
      if (resolver) { resolver(msg); this._pending.delete(`${msg.type}:${msg.fileId}`); }
    }
  }

  _awaitReply(type, fileId) {
    return new Promise((resolve) => this._pending.set(`${type}:${fileId}`, resolve));
  }

  /** @returns {Promise<{bytesPresent?:number, wholeChunks:number}>} */
  async checkResume(fileId, { suggestedName, chunkSize }) {
    if (this.engine === 'A') {
      const handle = await window.showSaveFilePicker({ suggestedName });
      this._handle = handle; // stashed until init()
      const reply = this._awaitReply('resumeOffset', fileId);
      this.worker.postMessage({ cmd: 'resumeInfo', fileId, handle, chunkSize });
      return reply;
    }
    const reply = this._awaitReply('resumeOffset', fileId);
    this.worker.postMessage({ cmd: 'resumeInfo', fileId });
    return reply;
  }

  async init(fileId, { name, mime, size, chunkSize, totalChunks }) {
    if (this.engine === 'A') {
      const handle = this._handle ?? await window.showSaveFilePicker({ suggestedName: name });
      const reply = this._awaitReply('ready', fileId);
      this.worker.postMessage({ cmd: 'init', fileId, handle, chunkSize, totalChunks });
      return reply;
    }
    const reply = this._awaitReply('ready', fileId);
    this.worker.postMessage({ cmd: 'init', fileId, name, mime, chunkSize, totalChunks });
    return reply;
  }

  /** buffer is transferred, not copied. */
  write(fileId, seq, buffer) {
    this.worker.postMessage({ cmd: 'write', fileId, seq, buffer }, [buffer]);
  }

  finalize(fileId) {
    this.worker.postMessage({ cmd: 'finalize', fileId });
  }

  abort(fileId) {
    this.worker.postMessage({ cmd: 'abort', fileId });
  }
}

/** Engine B only: turns a completed Blob into a real download via <a>. */
export function triggerBlobDownload(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

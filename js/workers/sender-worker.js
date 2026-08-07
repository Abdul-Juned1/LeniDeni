// ---------------------------------------------------------------------------
// Sender worker. Owns the File object; main thread never touches file bytes
// directly for the send path. Two responsibilities, kept separate on purpose:
//
//   1) analyze  -> magic-byte sniff + SHA-256 + VirusTotal check
//   2) send     -> chunk the file and hand chunks to the main thread, paced
//                  by a credit system (main thread grants credit as the
//                  RTCDataChannel drains; see transport.js)
//
// Chunking here is a plain byte-count slice, not the DataChannel's business
// logic — that stays on the main thread since RTCDataChannel objects can't
// be handed to a worker.
// ---------------------------------------------------------------------------

import { sniffMagicBytes, sha256Hex, vtLookupHash } from '../security.js';

const files = new Map(); // fileId -> { buffer: ArrayBuffer, chunkSize, nextSeq, totalChunks, credit, cancelled }

self.onmessage = async (event) => {
  const msg = event.data;
  try {
    switch (msg.cmd) {
      case 'analyze':      return await handleAnalyze(msg);
      case 'startSending': return handleStartSending(msg);
      case 'credit':       return handleCredit(msg);
      case 'cancel':       return handleCancel(msg);
    }
  } catch (err) {
    self.postMessage({ type: 'error', fileId: msg.fileId, message: String(err) });
  }
};

async function handleAnalyze({ fileId, file }) {
  const headSlice = await file.slice(0, 64).arrayBuffer();
  const sniff = sniffMagicBytes(new Uint8Array(headSlice), file.name);

  // Prototype-scope tradeoff: whole file is buffered once here so the same
  // bytes can be hashed and later sliced into chunks without re-reading
  // disk per chunk. Fine for course-project file sizes; very large files
  // would want a streaming SHA-256 instead (documented in README).
  const buffer = await file.arrayBuffer();
  const sha256 = await sha256Hex(buffer);
  const vt = await vtLookupHash(sha256);

  files.set(fileId, { buffer, chunkSize: null, nextSeq: 0, totalChunks: 0, credit: 0, cancelled: false });

  self.postMessage({
    type: 'analysis',
    fileId,
    sniff,
    sha256,
    vt,
    size: buffer.byteLength,
    name: file.name,
    mime: file.type || 'application/octet-stream',
  });
}

function handleStartSending({ fileId, chunkSize, initialCredit, resumeFromChunk = 0 }) {
  const entry = files.get(fileId);
  if (!entry) return self.postMessage({ type: 'error', fileId, message: 'analyze() was not called first' });

  entry.chunkSize = chunkSize;
  entry.totalChunks = Math.ceil(entry.buffer.byteLength / chunkSize) || 1;
  entry.nextSeq = Math.min(resumeFromChunk, entry.totalChunks);
  entry.credit = initialCredit;

  self.postMessage({ type: 'meta', fileId, totalChunks: entry.totalChunks, size: entry.buffer.byteLength });
  pump(fileId);
}

function handleCredit({ fileId, add }) {
  const entry = files.get(fileId);
  if (!entry) return;
  entry.credit += add;
  pump(fileId);
}

function handleCancel({ fileId }) {
  const entry = files.get(fileId);
  if (entry) entry.cancelled = true;
  files.delete(fileId);
}

function pump(fileId) {
  const entry = files.get(fileId);
  if (!entry || entry.cancelled) return;

  while (entry.credit > 0 && entry.nextSeq < entry.totalChunks) {
    const seq = entry.nextSeq++;
    const start = seq * entry.chunkSize;
    const end = Math.min(start + entry.chunkSize, entry.buffer.byteLength);
    // Copy the slice out (postMessage transfer detaches the buffer, and we
    // still need the master buffer for the remaining chunks).
    const chunk = entry.buffer.slice(start, end);
    entry.credit--;

    self.postMessage({ type: 'chunk', fileId, seq, totalChunks: entry.totalChunks, buffer: chunk }, [chunk]);
  }

  if (entry.nextSeq >= entry.totalChunks) {
    self.postMessage({ type: 'sent-all', fileId });
    files.delete(fileId);
  }
}

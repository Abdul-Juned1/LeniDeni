// ---------------------------------------------------------------------------
// Engine A worker: showSaveFilePicker() handle -> FileSystemWritableFileStream.
// A FileSystemFileHandle is structured-cloneable, so the main thread can
// hand it off here and every write happens off the main thread.
//
// Positioned writes ({type:'write', position, data}) mean out-of-order
// chunk arrival (expected, since the data channel is unordered) doesn't
// need to be resequenced before writing — each chunk lands at its own
// offset regardless of arrival order.
//
// Resumability: keepExistingData:true + a resume-offset query lets a
// dropped transfer restart from wherever the previous attempt left off,
// rather than from zero.
// ---------------------------------------------------------------------------

import { sha256Hex, vtLookupHash } from '../security.js';

const streams = new Map(); // fileId -> { handle, writable, chunkSize, receivedSeqs: Set, totalChunks }

self.onmessage = async (event) => {
  const msg = event.data;
  try {
    switch (msg.cmd) {
      case 'init':        return await handleInit(msg);
      case 'resumeInfo':  return await handleResumeInfo(msg);
      case 'write':        return await handleWrite(msg);
      case 'finalize':     return await handleFinalize(msg);
      case 'abort':        return await handleAbort(msg);
    }
  } catch (err) {
    self.postMessage({ type: 'error', fileId: msg.fileId, message: String(err) });
  }
};

async function handleInit({ fileId, handle, chunkSize, totalChunks }) {
  const writable = await handle.createWritable({ keepExistingData: true });
  streams.set(fileId, { handle, writable, chunkSize, totalChunks, receivedSeqs: new Set() });
  self.postMessage({ type: 'ready', fileId });
}

async function handleResumeInfo({ fileId, handle, chunkSize }) {
  // Best-effort: if a same-named partial file already exists on disk (from
  // a previous attempt at the same path), report how many whole chunks are
  // already present so the sender can be asked to skip ahead.
  try {
    const file = await handle.getFile();
    const wholeChunks = Math.floor(file.size / chunkSize);
    self.postMessage({ type: 'resumeOffset', fileId, bytesPresent: file.size, wholeChunks });
  } catch {
    self.postMessage({ type: 'resumeOffset', fileId, bytesPresent: 0, wholeChunks: 0 });
  }
}

async function handleWrite({ fileId, seq, buffer }) {
  const entry = streams.get(fileId);
  if (!entry) return;
  const position = seq * entry.chunkSize;
  await entry.writable.write({ type: 'write', position, data: buffer });
  entry.receivedSeqs.add(seq);

  self.postMessage({ type: 'progress', fileId, receivedChunks: entry.receivedSeqs.size, totalChunks: entry.totalChunks });

  if (entry.totalChunks && entry.receivedSeqs.size >= entry.totalChunks) {
    await finalize(fileId);
  }
}

async function handleFinalize({ fileId }) {
  await finalize(fileId);
}

async function finalize(fileId) {
  const entry = streams.get(fileId);
  if (!entry) return;
  await entry.writable.close();

  // Read the just-written file back to hash it — cheap (local disk) and
  // avoids maintaining a separate streaming-hash implementation.
  const file = await entry.handle.getFile();
  const buffer = await file.arrayBuffer();
  const sha256 = await sha256Hex(buffer);
  const vt = await vtLookupHash(sha256);

  streams.delete(fileId);
  self.postMessage({ type: 'complete', fileId, sha256, vt, size: file.size });
}

async function handleAbort({ fileId }) {
  const entry = streams.get(fileId);
  if (!entry) return;
  try { await entry.writable.abort(); } catch { /* best-effort */ }
  streams.delete(fileId);
}

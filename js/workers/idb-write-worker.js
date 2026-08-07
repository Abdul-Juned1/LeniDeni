// ---------------------------------------------------------------------------
// Engine B worker: IndexedDB-backed chunk storage for browsers without
// showSaveFilePicker (Firefox, Safari, older Chromium). IndexedDB is
// available inside workers directly, so this whole path stays off the
// main thread too.
//
// Chunks are keyed by [fileId, seq] so out-of-order arrival just means
// out-of-order writes to the store — reassembly sorts by seq afterwards.
// ---------------------------------------------------------------------------

import { sha256Hex, vtLookupHash } from '../security.js';

const DB_NAME = 'p2p-hyper-share';
const STORE = 'chunks';

let dbPromise = null;
function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: ['fileId', 'seq'] });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

const meta = new Map(); // fileId -> { totalChunks, chunkSize, mime, name, receivedSeqs: Set }

self.onmessage = async (event) => {
  const msg = event.data;
  try {
    switch (msg.cmd) {
      case 'init':       return await handleInit(msg);
      case 'resumeInfo': return await handleResumeInfo(msg);
      case 'write':      return await handleWrite(msg);
      case 'finalize':   return await handleFinalize(msg);
      case 'abort':      return await handleAbort(msg);
    }
  } catch (err) {
    self.postMessage({ type: 'error', fileId: msg.fileId, message: String(err) });
  }
};

async function handleInit({ fileId, name, mime, chunkSize, totalChunks }) {
  meta.set(fileId, { name, mime, chunkSize, totalChunks, receivedSeqs: new Set() });
  self.postMessage({ type: 'ready', fileId });
}

async function handleResumeInfo({ fileId }) {
  const db = await openDb();
  const seqs = await allSeqsForFile(db, fileId);
  self.postMessage({ type: 'resumeOffset', fileId, wholeChunks: seqs.length });
}

async function handleWrite({ fileId, seq, buffer }) {
  const db = await openDb();
  await idbPut(db, { fileId, seq, buffer });

  const entry = meta.get(fileId);
  if (entry) {
    entry.receivedSeqs.add(seq);
    self.postMessage({ type: 'progress', fileId, receivedChunks: entry.receivedSeqs.size, totalChunks: entry.totalChunks });
    if (entry.totalChunks && entry.receivedSeqs.size >= entry.totalChunks) await finalize(fileId);
  }
}

async function handleFinalize({ fileId }) {
  await finalize(fileId);
}

async function finalize(fileId) {
  const entry = meta.get(fileId);
  if (!entry) return;
  const db = await openDb();
  const records = await allRecordsForFile(db, fileId);
  records.sort((a, b) => a.seq - b.seq);

  const blob = new Blob(records.map((r) => r.buffer), { type: entry.mime || 'application/octet-stream' });
  const buffer = await blob.arrayBuffer();
  const sha256 = await sha256Hex(buffer);
  const vt = await vtLookupHash(sha256);

  await clearFile(db, fileId);
  meta.delete(fileId);

  self.postMessage({ type: 'complete', fileId, blob, sha256, vt, size: blob.size, name: entry.name });
}

async function handleAbort({ fileId }) {
  const db = await openDb();
  await clearFile(db, fileId);
  meta.delete(fileId);
}

// --- tiny IDB helpers -------------------------------------------------------
function idbPut(db, record) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
function allRecordsForFile(db, fileId) {
  return new Promise((resolve, reject) => {
    const range = IDBKeyRange.bound([fileId, -Infinity], [fileId, Infinity]);
    const out = [];
    const tx = db.transaction(STORE, 'readonly');
    const cursorReq = tx.objectStore(STORE).openCursor(range);
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (cursor) { out.push(cursor.value); cursor.continue(); } else resolve(out);
    };
    cursorReq.onerror = () => reject(cursorReq.error);
  });
}
async function allSeqsForFile(db, fileId) {
  const records = await allRecordsForFile(db, fileId);
  return records.map((r) => r.seq);
}
function clearFile(db, fileId) {
  return allRecordsForFile(db, fileId).then((records) => new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    records.forEach((r) => store.delete([r.fileId, r.seq]));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  }));
}

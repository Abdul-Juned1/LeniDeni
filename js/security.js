// ---------------------------------------------------------------------------
// Security primitives shared by the main thread and the workers.
// Nothing here is a hard gate on its own — see the README's "Security model
// is layered, not absolute" note. Each check is advisory input to the UI.
// ---------------------------------------------------------------------------

import { CONFIG } from './config.js';

// Signature -> [expected extensions]. Deliberately small: enough to catch
// "renamed .exe to .jpg" style spoofing, not a full file-type database.
const MAGIC_SIGNATURES = [
  { bytes: [0x4D, 0x5A], label: 'Windows executable (MZ/PE)', extensions: ['exe', 'dll', 'scr', 'msi'] },
  { bytes: [0x7F, 0x45, 0x4C, 0x46], label: 'ELF executable', extensions: ['', 'bin', 'run', 'so'] },
  { bytes: [0x89, 0x50, 0x4E, 0x47], label: 'PNG image', extensions: ['png'] },
  { bytes: [0xFF, 0xD8, 0xFF], label: 'JPEG image', extensions: ['jpg', 'jpeg'] },
  { bytes: [0x47, 0x49, 0x46, 0x38], label: 'GIF image', extensions: ['gif'] },
  { bytes: [0x25, 0x50, 0x44, 0x46], label: 'PDF document', extensions: ['pdf'] },
  { bytes: [0x50, 0x4B, 0x03, 0x04], label: 'ZIP-based archive (zip/docx/apk/jar)', extensions: ['zip', 'docx', 'xlsx', 'pptx', 'apk', 'jar'] },
  { bytes: [0x52, 0x61, 0x72, 0x21], label: 'RAR archive', extensions: ['rar'] },
  { bytes: [0x23, 0x21], label: 'Script with shebang', extensions: ['sh', 'py', 'rb', 'pl'] },
];

function bytesMatch(buf, sig) {
  return sig.every((b, i) => buf[i] === b);
}

export function extOf(fileName) {
  const dot = fileName.lastIndexOf('.');
  return dot === -1 ? '' : fileName.slice(dot + 1).toLowerCase();
}

export function isExecutableAdjacent(fileName) {
  return CONFIG.SECURITY.EXECUTABLE_ADJACENT_EXTENSIONS.includes(extOf(fileName));
}

/** @param {Uint8Array} head - first ~16-64 bytes of the file */
export function sniffMagicBytes(head, fileName) {
  const match = MAGIC_SIGNATURES.find((sig) => bytesMatch(head, sig.bytes));
  const declaredExt = extOf(fileName);
  if (!match) return { detected: null, declaredExt, mismatch: false };

  const mismatch = match.extensions.length > 0 && !match.extensions.includes(declaredExt);
  return { detected: match.label, declaredExt, mismatch };
}

export async function sha256Hex(arrayBuffer) {
  const digest = await crypto.subtle.digest('SHA-256', arrayBuffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Simple per-context rate limiter matching VT's public-API ceiling. Lives
// here (not just in the Pages Function) so the UI can show "throttled,
// waiting Ns" instead of just silently queuing.
class RateLimiter {
  constructor(maxPerMinute) {
    this.maxPerMinute = maxPerMinute;
    this.timestamps = [];
  }
  async wait() {
    const now = Date.now();
    this.timestamps = this.timestamps.filter((t) => now - t < 60000);
    if (this.timestamps.length >= this.maxPerMinute) {
      const waitMs = 60000 - (now - this.timestamps[0]) + 50;
      await new Promise((r) => setTimeout(r, waitMs));
      return this.wait();
    }
    this.timestamps.push(Date.now());
  }
}
const vtLimiter = new RateLimiter(CONFIG.SECURITY.VT_MAX_REQUESTS_PER_MINUTE);

/**
 * Looks up a SHA-256 hash against VirusTotal via the same-origin proxy
 * (functions/vt-lookup.js). Never calls VT directly — see that file's
 * header comment for why (CORS + API-key exposure).
 */
export async function vtLookupHash(sha256, { proxyPath = CONFIG.VT_PROXY_PATH } = {}) {
  await vtLimiter.wait();
  try {
    const res = await fetch(`${proxyPath}?hash=${sha256}`);
    if (res.status === 404) return { status: 'unknown', detail: 'Not previously seen by VirusTotal.' };
    if (!res.ok) return { status: 'error', detail: `Lookup failed (${res.status}).` };
    const data = await res.json();
    return data; // { status: 'clean'|'flagged'|'unknown', malicious, suspicious, total }
  } catch (err) {
    return { status: 'error', detail: String(err) };
  }
}

// ---------------------------------------------------------------------------
// Budget guardrail. This does not call Metered's usage API (that needs a
// backend token) — it counts what *this browser* has done this month and
// compares it to the documented free-tier ceilings, so you notice you're
// approaching a limit during testing instead of finding out from a bounced
// connection. It's a local trip-wire, not a billing dashboard.
// ---------------------------------------------------------------------------

import { CONFIG } from './config.js';

const STORAGE_KEY = 'p2phs-usage-v1';

function monthKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    if (raw.month !== monthKey()) return { month: monthKey(), messages: 0, turnBytes: 0, peakConcurrent: 0 };
    return raw;
  } catch {
    return { month: monthKey(), messages: 0, turnBytes: 0, peakConcurrent: 0 };
  }
}

function save(state) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

export class UsageTracker extends EventTarget {
  constructor() {
    super();
    this.state = load();
    this._emit();
  }

  recordSignalMessage(count = 1) {
    this.state.messages += count;
    save(this.state);
    this._emit();
  }

  recordConcurrent(activeConnections) {
    this.state.peakConcurrent = Math.max(this.state.peakConcurrent, activeConnections);
    save(this.state);
    this._emit();
  }

  /** Feed this from PeerLink 'path' events (bytesSent/bytesReceived on a relay candidate pair). */
  recordTurnBytes(deltaBytes) {
    if (deltaBytes <= 0) return;
    this.state.turnBytes += deltaBytes;
    save(this.state);
    this._emit();
  }

  snapshot() {
    const tier = CONFIG.METERED_FREE_TIER;
    return {
      messages: { used: this.state.messages, ceiling: tier.MESSAGES_PER_MONTH },
      concurrent: { used: this.state.peakConcurrent, ceiling: tier.CONCURRENT_CONNECTIONS },
      turnGB: { used: this.state.turnBytes / (1024 ** 3), ceiling: tier.TURN_GB_PER_MONTH },
    };
  }

  _emit() {
    this.dispatchEvent(new CustomEvent('update', { detail: this.snapshot() }));
    const snap = this.snapshot();
    for (const [key, { used, ceiling }] of Object.entries(snap)) {
      if (used / ceiling > 0.8) {
        console.warn(`[usage-guardrail] ${key} at ${(100 * used / ceiling).toFixed(0)}% of free-tier ceiling this month`);
      }
    }
  }
}

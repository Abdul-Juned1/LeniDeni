import { CONFIG } from '../config.js';
import { MeteredSignaling } from './metered-adapter.js';
import { CloudflareSignaling } from './cloudflare-adapter.js';

export function createSignaling() {
  return CONFIG.SIGNALING_BACKEND === 'cloudflare'
    ? new CloudflareSignaling()
    : new MeteredSignaling();
}

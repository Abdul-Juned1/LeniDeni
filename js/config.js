// ---------------------------------------------------------------------------
// Central config. Nothing here is a secret except METERED_API_KEY, and that
// key is a *publishable* key by design (Metered's dashboard issues pk_live_...
// keys meant to sit in client code — restrict it to your domain in the
// Metered dashboard under Realtime Messaging -> Keys, don't rely on secrecy).
//
// Do NOT put a VirusTotal key anywhere in this file or any client file.
// The VT key lives only as a Cloudflare Pages Function environment variable
// (see functions/vt-lookup.js) — that's the whole reason that proxy exists.
// ---------------------------------------------------------------------------

export const CONFIG = {
  // "metered" (default, zero server to run) or "cloudflare" (learning-exercise
  // fallback: a Durable Object you deploy yourself — see /cf-worker).
  SIGNALING_BACKEND: 'metered',

  METERED: {
    // Get a free publishable key at dashboard.metered.ca -> Realtime Messaging -> Keys.
    // Must have "Send" enabled or SDP/ICE messages silently won't deliver.
    API_KEY: 'pk_live_662df2a3d25781913dccf6600b2269e1de445c35',
    // REST fallback for TURN credentials if the SDK's auto-injected servers
    // are ever unavailable. Replace YOUR_APP_NAME with your Metered subdomain.
    TURN_REST_URL: 'https://lenideni.metered.live/api/v1/turn/credentials',
    TURN_REST_API_KEY: '8b3ed4a75bd983bda05fcf545909b5ee4802',
  },

  CLOUDFLARE_SIGNALING: {
    // wss:// URL of your deployed Durable Object worker (see /cf-worker).
    WS_URL: 'wss://p2p-hyper-share-signaling.YOUR_SUBDOMAIN.workers.dev',
  },

  // Always-free public STUN, included regardless of signaling backend.
  PUBLIC_STUN: [
    { urls: 'stun:stun.cloudflare.com:3478' },
    { urls: 'stun:stun.l.google.com:19302' },
  ],

  // Same-origin path to the CORS-safe VT proxy (Cloudflare Pages Function).
  // Works automatically once deployed to Pages — no key here.
  VT_PROXY_PATH: '/vt-lookup',

  TRANSPORT: {
    CHUNK_SIZE_MIN: 64 * 1024,
    CHUNK_SIZE_DEFAULT: 128 * 1024,
    CHUNK_SIZE_MAX: 256 * 1024,
    // Pause sending once this much is queued in the channel...
    BUFFERED_AMOUNT_HIGH: 16 * 1024 * 1024,
    // ...and resume once it drains below this (bufferedamountlow fires here).
    BUFFERED_AMOUNT_LOW: 4 * 1024 * 1024,
    THROUGHPUT_SAMPLE_MS: 500,
  },

  SECURITY: {
    // Advisory only — never the sole gate. See security.js.
    EXECUTABLE_ADJACENT_EXTENSIONS: [
      'exe', 'msi', 'bat', 'cmd', 'com', 'scr', 'ps1', 'vbs', 'vbe',
      'js', 'jse', 'wsf', 'wsh', 'jar', 'apk', 'app', 'dmg', 'pkg',
      'sh', 'bin', 'run', 'deb', 'rpm', 'lnk', 'reg', 'hta',
    ],
    CONFIRM_WORD: 'RUN',
    VT_MAX_REQUESTS_PER_MINUTE: 4, // matches VT public API's documented ceiling
  },

  // Metered free tier ceilings — used only to render the local usage gauges.
  METERED_FREE_TIER: {
    CONCURRENT_CONNECTIONS: 100,
    MESSAGES_PER_MONTH: 100000,
    TURN_GB_PER_MONTH: 20,
  },
};

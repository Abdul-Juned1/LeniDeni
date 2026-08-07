# P2P Hyper-Share

Direct browser-to-browser file transfer. Two people, a room code, and the
bytes never touch a server — signaling only exchanges tiny SDP/ICE messages,
and the file itself flows over a raw WebRTC data channel.

This is a **static site with zero required backend of your own**. No build
step, no `node_modules` to bundle for deployment — open `index.html` through
any static file server, or drag the folder into Cloudflare Pages / Vercel.

## Two corrections to the original spec

Everything in the original spec is implemented as written, with two
exceptions I changed and want to be upfront about:

**1. VirusTotal can't be called straight from the browser.**
VT's API doesn't send CORS headers permissive enough for arbitrary browser
origins, and even if it did, a VT key sitting in client JS is visible to
anyone who opens devtools — they could burn your free-tier quota or worse.
Fix: `functions/vt-lookup.js`, a **Cloudflare Pages Function**. It deploys
automatically alongside the static site (same repo, same free tier, nothing
extra to run) and keeps the real API key as a server-side environment
variable. The browser only ever talks to `/vt-lookup` on its own origin.

**2. Durable Objects are fine on the free plan** (confirmed — no $5/mo
Workers Paid commitment needed as of the DO free-tier rollout), so the
Cloudflare fallback signaling path in `/cf-worker` really is $0, using the
SQLite storage backend Durable Objects require on Free. This one isn't a
change from the spec, just a fact worth confirming before you build on it,
since DO pricing/plan requirements have shifted before.

Nothing else was substituted. Metered Open Relay is the default signaling +
TURN path exactly as specced; Cloudflare Workers + DO + Realtime TURN is
there as the alternate/learning path.

## Setup

### 1. Signaling backend — pick one in `js/config.js`

**Metered Open Relay (default, recommended for "just make it work"):**
1. Sign up free at [metered.ca](https://www.metered.ca), create an app.
2. Dashboard → Realtime Messaging → Keys → Create key → **Publishable**,
   with **Send enabled** (off by default — without it, peers connect but
   never exchange SDP/ICE).
3. Paste the `pk_live_...` key into `CONFIG.METERED.API_KEY`.
4. Also grab your TURN REST credentials (Dashboard → TURN Server → your app
   subdomain + API key) and fill in `TURN_REST_URL` / `TURN_REST_API_KEY` —
   this is only a fallback used if the SDK doesn't surface ICE servers
   directly, but it's fully documented and stable so it's worth having.

⚠️ **Before you rely on it**: `js/signaling/metered-adapter.js` has a header
comment flagging the exact two calls (`peer.send`, the `"message"` event
shape) that are educated-guess-from-docs rather than something I could run
against a live key. Cross-check those against
[metered.ca/docs/realtime-messaging/sdk-javascript](https://www.metered.ca/docs/realtime-messaging/sdk-javascript)
before a real demo — if the SDK has moved on, it's a one-function fix in
that file, not a rewrite.

**Cloudflare Workers + Durable Objects (learning-exercise path):**
1. `cd cf-worker && npx wrangler deploy`
2. Set `CONFIG.SIGNALING_BACKEND = 'cloudflare'` and point
   `CLOUDFLARE_SIGNALING.WS_URL` at the deployed worker's `.workers.dev` URL.
3. Optional: for TURN instead of STUN-only, `wrangler secret put
   CF_TURN_KEY_ID` and `CF_TURN_API_TOKEN` (Cloudflare dashboard → Realtime →
   TURN). Free tier: 1,000 GB/month, $0.05/GB after.

### 2. VirusTotal proxy

Cloudflare has two different deployment models and which one your project
uses changes where this logic lives:

- **Classic Pages (git-connected "Pages" project type, auto-builds `/functions`):**
  `functions/vt-lookup.js` is picked up automatically. Just set the
  `VT_API_KEY` environment variable in the project's Settings.
- **Workers with static assets (the current default for new "Workers & Pages"
  projects — what you likely have if Settings → Variables and secrets says
  "Variables cannot be added to a Worker that only has static assets"):**
  a static-assets-only project has no runtime script, so there's nothing to
  attach env vars to. Use `worker/index.js` + `wrangler.jsonc` instead —
  that's a real Worker entry point that serves the static files via the
  `ASSETS` binding and handles `/vt-lookup` itself. Once it's deployed,
  Variables and secrets unlocks normally; add `VT_API_KEY` there (as a
  **secret**, not a plaintext variable).

Either way, deploy with `VT_API_KEY` from
[virustotal.com/gui/my-apikey](https://www.virustotal.com/gui/my-apikey).

### 3. Open two tabs (or two devices) and go

One clicks **Create a room**, shares the 6-character code, the other pastes
it into **Join**. Drop a file once the telemetry panel shows a connected
path.

## Architecture at a glance

```
Signaling (Metered or CF Durable Object) — SDP/ICE only, ~nothing else
        │
        ▼
RTCPeerConnection + one RTCDataChannel({ ordered: false })   [webrtc.js]
        │
        ▼
Transport: 8-byte header framing, credit-based backpressure,   [transport.js]
adaptive chunk size (64/128/256 KB), throughput + path telemetry
        │
        ├── sender-worker.js    read + chunk + hash + VT check, off-thread
        └── fs-write-worker.js / idb-write-worker.js   [save-engine.js]
            Engine A (showSaveFilePicker, resumable) or
            Engine B (IndexedDB → Blob → <a download>)
```

## Known simplifications (student-prototype scope, called out on purpose)

- **Whole-file buffering for hashing.** `sender-worker.js` reads the entire
  file into memory once so the same bytes can be hashed and chunked without
  re-touching disk. Fine for coursework-sized files; very large files would
  want a streaming SHA-256 instead of Web Crypto's single-shot `digest()`.
- **Resume is chunk-index-based, not gap-aware.** On reconnect, the receiver
  reports how many *leading* chunks it already has and the sender starts
  from there. Because the channel is unordered, a real dropped connection
  could in principle leave a gap earlier in the file that this doesn't
  detect. Good enough for "wifi hiccupped, reconnect and continue"; not a
  BitTorrent-grade rarest-first resume.
- **Engine A's `showSaveFilePicker()` needs a live user gesture.** It's
  called from the same click that accepts an incoming file offer — see the
  timing note in `app.js` above `acceptIncoming()`. Don't add an `await`
  before that call or Chromium will reject it.
- **Security checks are advisory, not a gate.** The extension list, magic-byte
  sniff, and VirusTotal hash lookup all *inform* a typed-confirmation prompt;
  none of them block a determined user, and a VT "clean" doesn't mean safe
  (zero-day malware won't have a signature yet). Treat this as friction
  against accidents, not a security boundary.

## Budget guardrails

`js/usage-tracker.js` counts signaling messages, peak concurrent links, and
estimated TURN-relayed bytes (from `RTCPeerConnection.getStats()`) in
`localStorage`, resetting monthly, and renders gauges against Metered's
published free-tier ceilings (100 concurrent / 100k messages-month / 20
GB TURN-month). It's a local trip-wire so you notice at 80%, not a real
usage API — Metered doesn't expose one without a backend token, which would
defeat the "no server" point of this whole architecture.

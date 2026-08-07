// ---------------------------------------------------------------------------
// GET /vt-lookup?hash=<sha256>
//
// WHY THIS FILE EXISTS (read this before deleting it):
// The original zero-server design called for calling VirusTotal's API
// directly from the browser. Two things make that not actually work:
//   1. VirusTotal's API does not send permissive CORS headers for arbitrary
//      browser origins, so `fetch()` from client JS gets blocked.
//   2. Even if it did, a VT API key embedded in client-side code is visible
//      to anyone who opens devtools — they could exhaust or hijack your
//      free-tier quota.
// This function is the fix: it's a Cloudflare Pages Function, which deploys
// automatically with the static site (same free tier, same repo, no
// separate service to run) and keeps the real VT_API_KEY as a server-side
// environment variable that the browser never sees.
//
// Setup: Cloudflare Pages dashboard -> your project -> Settings ->
// Environment variables -> add VT_API_KEY (get a free key at
// virustotal.com/gui/my-apikey). Free tier: 500 requests/day, 4/minute —
// security.js's client-side rate limiter already paces requests to match.
// ---------------------------------------------------------------------------

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const hash = url.searchParams.get('hash');

  if (!hash || !/^[a-f0-9]{64}$/i.test(hash)) {
    return json({ status: 'error', detail: 'Missing or malformed sha256 hash.' }, 400);
  }
  if (!env.VT_API_KEY) {
    return json({ status: 'error', detail: 'VT_API_KEY not configured on the server.' }, 500);
  }

  const vtRes = await fetch(`https://www.virustotal.com/api/v3/files/${hash}`, {
    headers: { 'x-apikey': env.VT_API_KEY },
  });

  if (vtRes.status === 404) {
    return json({ status: 'unknown', detail: 'Not previously seen by VirusTotal.' });
  }
  if (!vtRes.ok) {
    return json({ status: 'error', detail: `VirusTotal returned ${vtRes.status}.` }, 502);
  }

  const data = await vtRes.json();
  const stats = data?.data?.attributes?.last_analysis_stats ?? {};
  const malicious = stats.malicious ?? 0;
  const suspicious = stats.suspicious ?? 0;
  const total = Object.values(stats).reduce((a, b) => a + b, 0);

  return json({
    status: malicious > 0 || suspicious > 0 ? 'flagged' : 'clean',
    malicious, suspicious, total,
  });
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

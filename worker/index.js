// ---------------------------------------------------------------------------
// Entry point for the "Workers with static assets" deployment model.
//
// Classic Cloudflare Pages auto-built a `/functions` directory into request
// handlers for you. The newer unified Workers dashboard doesn't do that
// same auto-build for git-connected projects — a project with nothing but
// an `assets` directory and no `main` script is treated as static-only,
// which is exactly why Settings -> Variables and secrets was disabled
// ("Variables cannot be added to a Worker that only has static assets").
//
// This file IS the Worker script: it owns the one dynamic route
// (/vt-lookup) itself and defers everything else to the static asset
// binding. Once this is wired up via wrangler.jsonc, the project has a
// real runtime and the Variables/Secrets UI becomes available.
// ---------------------------------------------------------------------------

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/vt-lookup' && request.method === 'GET') {
      return handleVtLookup(url, env);
    }

    // Everything else — index.html, css/, js/ — is served from the
    // static assets binding configured in wrangler.jsonc.
    return env.ASSETS.fetch(request);
  },
};

async function handleVtLookup(url, env) {
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

// Every path the gateway owns. Whatever serves the SPA has to divert these to
// the gateway rather than answer them with the SPA fallback, so the same set is
// restated once per hosting topology that needs a gateway allowlist, each in
// that topology's own syntax:
//
//   - Here, as `server.proxy` prefixes for the `vite dev` + `wrangler dev` pair.
//   - As the `location ~` regexes in docker/nginx.conf, for the docker-compose
//     self-host topology.
//   - As `assets.run_worker_first` in wrangler.example.jsonc, for production on
//     Cloudflare, where Workers Static Assets serves the SPA.
//
// The Node Local Runtime does not restate this list. It allowlists the known
// Dashboard navigation and static paths instead, then sends every other path
// directly to the gateway. New gateway routes therefore remain gateway-owned
// without requiring a fourth list to change in lockstep.
//
// Drift is silent and surfaces only as a 404 the SPA fallback served for a real
// gateway endpoint, so `__tests__/gateway-paths_test.ts` replays the public
// data-plane route table through all three and fails when any of them stops
// covering it.
//
// Bare data-plane paths are listed because the gateway accepts both root and
// `/v1` forms where the upstream protocol defines them.
export const wranglerProxiedPaths = [
  '/api',
  '/auth',
  '/favicon.ico',
  '/v1',
  '/v2',
  '/v1beta',
  '/jina',
  '/voyage',
  '/azure-api.codex',
  '/alpha/search',
  '/completions',
  '/chat/completions',
  '/responses',
  '/messages',
  '/embeddings',
  '/models',
  '/images/generations',
  '/images/edits',
];

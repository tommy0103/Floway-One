// Every path the gateway owns. Whatever serves the SPA has to divert these to
// the gateway rather than answer them with the SPA fallback, so the same set is
// restated once per hosting topology, each in that topology's own syntax:
//
//   - Here, as `server.proxy` prefixes for the `vite dev` + `wrangler dev` pair.
//   - As the `location ~` regexes in docker/nginx.conf, for the docker-compose
//     self-host topology.
//   - As `assets.run_worker_first` in wrangler.example.jsonc, for production on
//     Cloudflare, where Workers Static Assets serves the SPA.
//
// Drift is silent and surfaces only as a 404 the SPA fallback served for a real
// gateway endpoint, so the web gateway-path test and the Node Local Runtime
// test replay the public data-plane route table through every topology and fail
// when any of them stops covering it.
//
// Bare data-plane paths are listed because the gateway accepts both root and
// `/v1` forms where the upstream protocol defines them.
export { gatewayOwnedPathPrefixes as wranglerProxiedPaths } from '@floway-dev/protocols/common';

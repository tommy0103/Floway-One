// Hosting layers use these prefixes only to decide whether an HTTP request is
// owned by the Floway gateway or by a colocated static application. The public
// data-plane table remains the authority for individual endpoint methods and
// paths; gateway-paths tests replay that table through this coarser boundary.
export const gatewayOwnedPathPrefixes = [
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
] as const;

export const isGatewayOwnedPath = (pathname: string): boolean =>
  gatewayOwnedPathPrefixes.some(prefix => pathname === prefix || pathname.startsWith(`${prefix}/`));

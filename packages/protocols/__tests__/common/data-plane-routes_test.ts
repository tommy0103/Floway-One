import { expect, test } from 'vitest';

import {
  isPublicDataPlaneRequest,
  PUBLIC_DATA_PLANE_ROUTES,
} from '../../src/common/data-plane-routes.ts';

const concretePath = (pattern: string): string =>
  pattern.replace(/:\w+\{\.\+\}$/, 'model-family/model:action');

test('recognizes every registered public data-plane method and path from the authoritative table', () => {
  for (const route of Object.values(PUBLIC_DATA_PLANE_ROUTES)) {
    for (const pattern of route.paths) {
      const path = concretePath(pattern);
      expect(isPublicDataPlaneRequest(route.method, path), `${route.method} ${path}`).toBe(true);
      expect(isPublicDataPlaneRequest('DELETE', path), path).toBe(false);
    }
  }
});

test('does not classify control-plane, public auth, static, or unknown prefix paths as data plane', () => {
  for (const [method, path] of [
    ['GET', '/api/keys'],
    ['POST', '/api/keys'],
    ['POST', '/auth/login'],
    ['POST', '/auth/bootstrap'],
    ['GET', '/api/health'],
    ['GET', '/favicon.ico'],
    ['POST', '/v1/not-a-real-protocol'],
    ['GET', '/v1beta/models/'],
  ] as const) {
    expect(isPublicDataPlaneRequest(method, path), `${method} ${path}`).toBe(false);
  }
});

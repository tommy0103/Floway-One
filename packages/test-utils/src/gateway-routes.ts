import { PUBLIC_DATA_PLANE_ROUTES } from '@floway-dev/protocols/common';

// Hono path parameters carry an optional inline pattern, e.g.
// `/v1beta/models/:modelAction{.+}`. A concrete sample is what hosting-layer
// matchers need, and Gemini's action form puts a colon inside one segment.
const SAMPLE_SEGMENT: Record<string, string> = {
  modelAction: 'gemini-2.5-pro:generateContent',
  modelId: 'gemini-2.5-pro',
};

const concreteUrl = (path: string) =>
  path.replaceAll(/:(\w+)(?:\{.*\})?/g, (_, name: string) => {
    const sample = SAMPLE_SEGMENT[name];
    if (sample === undefined) throw new Error(`No sample segment for route parameter :${name}`);
    return sample;
  });

export const gatewayTestUrls = [
  ...new Set(Object.values(PUBLIC_DATA_PLANE_ROUTES).flatMap(route => route.paths.map(concreteUrl))),
  // The control plane and favicon have no public data-plane manifest. One
  // representative path per mounted surface catches a dropped prefix.
  '/api/upstreams',
  '/auth/login',
  '/favicon.ico',
];

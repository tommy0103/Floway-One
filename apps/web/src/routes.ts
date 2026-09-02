import { type RouteConfig, index, route } from '@react-router/dev/routes';

import { dashboardRoute, homeRoute } from '../dashboard-routes';

// The gallery renders every Fluent control the dashboard uses so the WinUI
// layer can be judged in one place. It is scaffolding, not a product surface:
// no navigation entry, no translations, and its copy is English placeholder
// text. This table is its only importer, so gating it here is what keeps the
// module out of a shipped bundle rather than merely out of the menu.
//
// MODE and not DEV: this file is not part of the bundle Vite is building. It
// runs inside the nested server @react-router/dev spins up to resolve the route
// table, which is created with the outer command's mode but inherits the
// loader process's NODE_ENV. Vite sets MODE from the mode it was given and
// derives DEV and PROD from NODE_ENV alone, so DEV here reports the ambient
// environment while MODE reports the build. Reading DEV was wrong in both
// directions: it dropped the route from react-router dev, and it restored the
// route to a production build whenever NODE_ENV said development.
// https://github.com/vitejs/vite/blob/v8.1.5/packages/vite/src/node/config.ts#L2007-L2013
const developmentRoutes =
  import.meta.env.MODE === 'development'
    ? [route('winui-gallery', 'routes/dashboard-winui-gallery.tsx')]
    : [];

export default [
  index(homeRoute.file),
  route(dashboardRoute.path, dashboardRoute.file, [
    ...dashboardRoute.children.map(child =>
      'path' in child ? route(child.path, child.file) : index(child.file)),
    ...developmentRoutes,
  ]),
] satisfies RouteConfig;

export const homeRoute = {
  index: true,
  file: 'routes/home.tsx',
} as const;

export const dashboardRoute = {
  path: 'dashboard',
  file: 'routes/dashboard.tsx',
  children: [
    { index: true, file: 'routes/dashboard-index.tsx' },
    { path: 'playground', file: 'routes/dashboard-playground.tsx' },
    { path: 'providers/upstreams', file: 'routes/dashboard-providers-upstreams.tsx' },
    { path: 'providers/upstreams/new/:provider', file: 'routes/dashboard-providers-upstreams-new.tsx' },
    { path: 'providers/upstreams/:id', file: 'routes/dashboard-providers-upstreams-edit.tsx' },
    { path: 'providers/search', file: 'routes/dashboard-providers-search.tsx' },
    { path: 'providers/proxy', file: 'routes/dashboard-providers-proxy.tsx' },
    { path: 'providers/model-aliases', file: 'routes/dashboard-providers-model-aliases.tsx' },
    { path: 'services/api-keys', file: 'routes/dashboard-services-api-keys.tsx' },
    { path: 'services/api-docs', file: 'routes/dashboard-services-api-docs.tsx' },
    { path: 'monitor/requests', file: 'routes/dashboard-monitor-requests.tsx' },
    { path: 'monitor/usage', file: 'routes/dashboard-monitor-usage.tsx' },
    { path: 'monitor/performance', file: 'routes/dashboard-monitor-performance.tsx' },
    { path: 'admin/users', file: 'routes/dashboard-admin-users.tsx' },
    { path: 'admin/backup-restore', file: 'routes/dashboard-admin-backup-restore.tsx' },
    { path: 'settings', file: 'routes/dashboard-settings.tsx' },
  ],
} as const;

export const productionDashboardNavigationPaths = [
  ...(homeRoute.index ? ['/'] : []),
  ...(dashboardRoute.children.some(child => 'index' in child) ? [`/${dashboardRoute.path}`] : []),
  ...dashboardRoute.children.flatMap(child =>
    'path' in child ? [`/${dashboardRoute.path}/${child.path}`] : []),
];

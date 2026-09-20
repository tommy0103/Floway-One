import {
  Chat20Color,
  Clipboard20Color,
  Cloud20Color,
  Database20Color,
  DataPie20Color,
  DocumentText20Color,
  Gauge20Color,
  Home20Color,
  People20Color,
  Person20Color,
  PersonKey20Color,
  SearchSparkle20Color,
  ShareAndroid20Color,
  TextEditStyle20Color,
} from '@fluentui/react-icons';
import type { FluentIcon } from '@fluentui/react-icons';

import type { DashboardRuntimeCapabilities } from '../../api/runtime-info';

export interface DashboardPage {
  to: string;
  labelKey: string;
  icon: FluentIcon;
  adminOnly?: boolean;
  /** Shown only under the personal runtime profile; see nav.tsx for the gate. */
  personalOnly?: boolean;
  requiredCapability?: keyof DashboardRuntimeCapabilities;
}

export interface NavGroup {
  labelKey?: string;
  adminOnly?: boolean;
  items: DashboardPage[];
}

export const dashboardPageAvailable = (
  page: DashboardPage,
  capabilities: DashboardRuntimeCapabilities,
): boolean => page.requiredCapability === undefined || capabilities[page.requiredCapability];

export const usersPage: DashboardPage = {
  to: '/dashboard/admin/users',
  labelKey: 'dashboard.nav.users',
  icon: People20Color,
  requiredCapability: 'userManagement',
};

// The personal profile's landing page, addressed by the dashboard index route.
// Its `to` is the dashboard root itself, which every other destination
// prefixes, so selection matching treats it as exact-only (see nav.tsx).
export const overviewPage: DashboardPage = {
  to: '/dashboard',
  labelKey: 'dashboard.nav.overview',
  icon: Home20Color,
  personalOnly: true,
};

// The sidebar carries Fluent's multi-colour glyphs, where WinUI's
// NavigationView draws monochrome ones and moves the icon and the label to the
// same brush in every visual state. These assets hard-code their gradient
// stops and consume no currentColor, so the per-state foreground
// winui/controls/nav.css.ts substitutes reaches the label and stops there: a
// row's glyph holds its colour through hover, press and selection. Swapping the
// set to the monochrome Regular/Filled pair is what would close that, and it is
// a product decision about the sidebar's look rather than a styling one.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/NavigationView/NavigationView_themeresources.xaml#L460-L491
export const navGroups: NavGroup[] = [
  {
    items: [
      overviewPage,
      { to: '/dashboard/playground', labelKey: 'dashboard.nav.playground', icon: Chat20Color },
    ],
  },
  {
    labelKey: 'dashboard.groups.providers',
    items: [
      { to: '/dashboard/providers/upstreams', labelKey: 'dashboard.nav.upstreams', icon: Cloud20Color, adminOnly: true },
      { to: '/dashboard/providers/search', labelKey: 'dashboard.nav.search', icon: SearchSparkle20Color, adminOnly: true },
      { to: '/dashboard/providers/proxy', labelKey: 'dashboard.nav.proxy', icon: ShareAndroid20Color, adminOnly: true },
      { to: '/dashboard/providers/model-aliases', labelKey: 'dashboard.nav.modelAliases', icon: TextEditStyle20Color, adminOnly: true },
    ],
  },
  {
    labelKey: 'dashboard.groups.services',
    items: [
      { to: '/dashboard/services/api-keys', labelKey: 'dashboard.nav.apiKeys', icon: PersonKey20Color },
      { to: '/dashboard/services/api-docs', labelKey: 'dashboard.nav.apiDocs', icon: DocumentText20Color },
    ],
  },
  {
    labelKey: 'dashboard.groups.monitor',
    items: [
      { to: '/dashboard/monitor/requests', labelKey: 'dashboard.nav.requests', icon: Clipboard20Color },
      { to: '/dashboard/monitor/usage', labelKey: 'dashboard.nav.usage', icon: DataPie20Color },
      { to: '/dashboard/monitor/performance', labelKey: 'dashboard.nav.performance', icon: Gauge20Color },
    ],
  },
  {
    labelKey: 'dashboard.groups.admin',
    adminOnly: true,
    items: [
      usersPage,
      { to: '/dashboard/admin/backup-restore', labelKey: 'dashboard.nav.backupRestore', icon: Database20Color },
    ],
  },
];

// The account page is reached from the drawer's footer, where the row carries
// the signed-in user's name rather than the page's own; everything else that
// names a page -- the selection indicator, the document title -- still needs it
// under its own label.
export const accountPage: DashboardPage = {
  to: '/dashboard/settings',
  labelKey: 'dashboard.nav.settings',
  icon: Person20Color,
};

export const dashboardPages: DashboardPage[] = [...navGroups.flatMap(group => group.items), accountPage];

export const pageLabelKeys = new Map(dashboardPages.map(page => [page.to, page.labelKey]));

// The page a pathname selects. Every page owns a subtree and answers a prefix
// match, except the overview: it sits on the dashboard root itself, which is a
// prefix of every destination, so it answers an exact match alone.
export const dashboardPageForPathname = (pathname: string): DashboardPage | undefined =>
  dashboardPages.find(page => page.to === overviewPage.to
    ? pathname === page.to
    : pathname === page.to || pathname.startsWith(`${page.to}/`));

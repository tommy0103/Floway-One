import { describe, expect, it } from 'vitest';

import { dashboardPageForPathname, overviewPage } from '../../../src/components/sidebar/pages';

describe('dashboardPageForPathname', () => {
  it('selects the overview on the dashboard root alone', () => {
    expect(dashboardPageForPathname('/dashboard')?.to).toBe(overviewPage.to);
  });

  it.each([
    '/dashboard/playground',
    '/dashboard/services/api-keys',
    '/dashboard/monitor/requests',
    '/dashboard/settings',
  ])('never selects the overview under %s', pathname => {
    const page = dashboardPageForPathname(pathname);
    expect(page).toBeDefined();
    expect(page?.to).not.toBe(overviewPage.to);
  });

  it('keeps prefix matching inside a page subtree', () => {
    expect(dashboardPageForPathname('/dashboard/providers/upstreams')?.to).toBe('/dashboard/providers/upstreams');
    expect(dashboardPageForPathname('/dashboard/providers/upstreams/up-1')?.to).toBe('/dashboard/providers/upstreams');
  });
});

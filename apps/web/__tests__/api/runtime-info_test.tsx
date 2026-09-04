import { act, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, useRouteError } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadRuntimeInfo } from '../../src/api/runtime-info';
import { FlowayErrorBoundary } from '../../src/components/error-boundary';
import { i18n, setLanguage } from '../../src/i18n';
import { defaultLanguage, type SupportedLanguage } from '../../src/i18n/languages';
import { LocalizedError } from '../../src/i18n/localized-error';
import { renderInApp } from '../render';

afterEach(async () => {
  await setLanguage(defaultLanguage);
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const RouteErrorBoundary = () => {
  const error = useRouteError();
  return <FlowayErrorBoundary {...({ error } as Parameters<typeof FlowayErrorBoundary>[0])} />;
};

describe('runtime capability loading', () => {
  it.each<{
    language: SupportedLanguage;
    message: string;
  }>([
    {
      language: 'en',
      message: 'Runtime capabilities could not be loaded. Refresh after the gateway is available.',
    },
    {
      language: 'zh-Hans',
      message: '无法加载运行时能力。请在网关可用后刷新。',
    },
  ])('renders a localized $language route error without losing its transport cause', async ({ language, message }) => {
    const transportError = new Error(`transport failure in ${language}`);
    transportError.stack = `Error: transport failure in ${language}\n    at forcedTransportFrame (https://gateway.test/transport.ts:7:11)`;
    vi.stubEnv('DEV', true);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(transportError));
    await act(async () => { await setLanguage(language); });
    let routedError: unknown;
    const router = createMemoryRouter([{
      path: '/',
      Component: () => null,
      ErrorBoundary: RouteErrorBoundary,
      loader: async () => {
        try {
          return await loadRuntimeInfo();
        } catch (error) {
          routedError = error;
          throw error;
        }
      },
    }], { initialEntries: ['/'] });

    renderInApp(<RouterProvider router={router} />);

    await waitFor(() => expect(screen.getByRole('main').textContent).toContain(message));
    const visible = screen.getByRole('main').textContent ?? '';
    expect(i18n.language).toBe(language);
    expect(visible).toContain(`LocalizedError: ${message}`);
    expect(visible).not.toContain('common.errors.runtimeCapabilitiesUnavailable');
    expect(routedError).toBeInstanceOf(LocalizedError);
    const apiError = (routedError as LocalizedError).cause as { cause?: unknown };
    expect(apiError.cause).toBe(transportError);
    expect((apiError.cause as Error).stack).toBe(transportError.stack);
  });
});

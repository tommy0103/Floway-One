import { fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DesktopExternalLinks, isExternalHttpsHref } from '../../src/components/desktop-external-links';
import { i18n } from '../../src/i18n';
import { renderInApp } from '../render';
import { settle } from '../settle';

const externalOpen = (key: string) => i18n.t(`common.externalOpen.${key}`);

interface RegisteredListener {
  event: string;
  handler: (event: { payload: { code?: string; detail?: unknown } }) => void;
  unlisten: () => void;
}

const mode = vi.hoisted(() => ({
  invoke: vi.fn(),
  isTauri: true,
  listeners: [] as RegisteredListener[],
}));

vi.mock('@tauri-apps/api/core', () => ({
  isTauri: () => mode.isTauri,
  invoke: (...args: unknown[]) => mode.invoke(...args),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: (event: string, handler: RegisteredListener['handler']) => {
    const registered: RegisteredListener = {
      event,
      handler,
      unlisten: () => {
        const index = mode.listeners.indexOf(registered);
        if (index >= 0) mode.listeners.splice(index, 1);
      },
    };
    mode.listeners.push(registered);
    return Promise.resolve(registered.unlisten);
  },
}));

const ANCHOR_HREF = 'https://auth.openai.com/oauth/authorize?client_id=app_x&state=st';

const renderPage = () => {
  renderInApp(
    <div>
      <DesktopExternalLinks />
      <a data-testid="external" href={ANCHOR_HREF}>authorize</a>
      <a data-testid="internal" href="/dashboard/providers">upstreams</a>
      <a data-testid="plain-http" href="http://docs.example.test/">docs</a>
    </div>,
  );
};

const click = (testId: string): MouseEvent => {
  const anchor = screen.getByTestId(testId);
  const event = new MouseEvent('click', { bubbles: true, cancelable: true });
  anchor.dispatchEvent(event);
  return event;
};

beforeEach(() => {
  mode.invoke.mockReset();
  mode.invoke.mockResolvedValue(undefined);
  mode.listeners.length = 0;
  mode.isTauri = true;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('DesktopExternalLinks', () => {
  it('routes external https clicks through the shell open command', async () => {
    renderPage();
    const event = click('external');
    await settle();

    expect(event.defaultPrevented).toBe(true);
    expect(mode.invoke).toHaveBeenCalledWith('open_external', { url: `${ANCHOR_HREF}` });
  });

  it('leaves same-origin and non-https anchors to the browser', async () => {
    renderPage();

    const internal = click('internal');
    const plainHttp = click('plain-http');

    expect(mode.invoke).not.toHaveBeenCalled();
    expect(internal.defaultPrevented).toBe(false);
    expect(plainHttp.defaultPrevented).toBe(false);
  });

  it('intercepts modified and middle activations of external anchors', async () => {
    renderPage();
    const anchor = screen.getByTestId('external');

    const modified = new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true });
    anchor.dispatchEvent(modified);
    const middle = new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 });
    anchor.dispatchEvent(middle);
    await settle();

    expect(modified.defaultPrevented).toBe(true);
    expect(middle.defaultPrevented).toBe(true);
    expect(mode.invoke).toHaveBeenCalledTimes(2);
  });

  it('surfaces a localized failure with the shell error chain and dismisses it', async () => {
    mode.invoke.mockRejectedValue('external-open:failed\ncaused by: the browser refused');
    renderPage();
    click('external');
    await settle();

    const message = screen.getByText(`${externalOpen('failed')} caused by: the browser refused`);
    expect(message).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: i18n.t('common.dismiss') }));
    await settle();
    expect(screen.queryByText(externalOpen('failed'))).toBeNull();
  });

  it('reports the backstop event when the shell drops a link click', async () => {
    renderPage();
    await settle();
    expect(mode.listeners).toHaveLength(1);

    mode.listeners[0]!.handler({ payload: { code: 'external-open:failed', detail: 'launch failed' } });
    await settle();
    expect(screen.getByText(`${externalOpen('failed')} launch failed`)).toBeTruthy();
  });

  it('does nothing outside Tauri', async () => {
    mode.isTauri = false;
    renderPage();
    await settle();

    const event = click('external');
    expect(event.defaultPrevented).toBe(false);
    expect(mode.invoke).not.toHaveBeenCalled();
    expect(mode.listeners).toHaveLength(0);
  });
});

describe('isExternalHttpsHref', () => {
  const origin = 'http://127.0.0.1:49400';

  it('accepts absolute https URLs away from the origin', () => {
    expect(isExternalHttpsHref('https://github.com/login/device', origin)).toBe('https://github.com/login/device');
    expect(isExternalHttpsHref('/relative', origin)).toBeNull();
    expect(isExternalHttpsHref('http://docs.example.test/', origin)).toBeNull();
    // The scheme change makes this a different origin, and the shell's own
    // policy (not this gate) owns the final decision for it.
    expect(isExternalHttpsHref('https://127.0.0.1:49400/page', origin)).toBe('https://127.0.0.1:49400/page');
    expect(isExternalHttpsHref('https://user:secret@example.test/', origin)).toBeNull();
    expect(isExternalHttpsHref('not a url', origin)).toBeNull();
  });
});

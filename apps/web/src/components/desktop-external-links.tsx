
import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useEffect, useState } from 'react';

import { useTranslation } from '../i18n/translation';
import { OutcomeMessageBar } from './ui/outcome-message-bar';

// The desktop shell hands external links to the system browser (spec §8). A
// plain `target="_blank"` click depends on the WKWebView new-window plumbing,
// which can drop the request with no visible effect (#45), so inside Tauri the
// Dashboard intercepts external https anchors and calls the shell's
// `open_external` command directly. The shell's `on_new_window` handler stays
// armed as the backstop for anything that bypasses this interception, and it
// reports failures on the same event this component listens for.

const EXTERNAL_OPEN_FAILED_EVENT = 'external-open-failed';
const EXTERNAL_OPEN_COMMAND = 'open_external';

// Resolves an anchor's raw href the way a click would and answers whether it
// must leave the webview: an absolute https URL pointing away from the
// Dashboard origin, carrying no embedded credentials. The shell re-decides
// with the full navigation policy; this gate only avoids intercepting what
// the browser should keep handling.
export const isExternalHttpsHref = (href: string, origin: string): string | null => {
  try {
    const parsed = new URL(href, origin);
    if (parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== '') return null;
    if (parsed.origin === new URL(origin).origin) return null;
    return parsed.toString();
  } catch {
    return null;
  }
};

// The shell answers with stable codes (`external-open:*`, optionally followed
// by the error chain it also logs) so this surface can localize the message.
const externalOpenMessage = (raw: unknown, t: (key: string) => string): string => {
  const text = typeof raw === 'string' ? raw : String(raw);
  const [code = '', ...rest] = text.split('\n');
  const detail = rest.join('\n').trim();
  const key = code === 'external-open:not-ready'
    ? 'notReady'
    : code === 'external-open:invalid-url'
      ? 'invalid'
      : code === 'external-open:rejected'
        ? 'rejected'
        : 'failed';
  const message = t(`common.externalOpen.${key}`);
  return detail.length > 0 ? `${message} ${detail}` : message;
};

export function DesktopExternalLinks() {
  const { t } = useTranslation();
  const [error, setError] = useState<string | null>(null);

  // The backstop's failures: `handle_navigation` reports a system-browser
  // handoff error here instead of exiting the app.
  useEffect(() => {
    if (!isTauri()) return;
    const unlisten = listen<{ detail?: unknown }>(EXTERNAL_OPEN_FAILED_EVENT, event => {
      const detail = typeof event.payload.detail === 'string' ? event.payload.detail.trim() : '';
      setError(detail.length > 0 ? `${t('common.externalOpen.failed')} ${detail}` : t('common.externalOpen.failed'));
    });
    return () => { void unlisten.then(dispose => dispose()); };
  }, [t]);

  useEffect(() => {
    if (!isTauri()) return;
    const onClick = (event: MouseEvent): void => {
      if (event.defaultPrevented || event.button !== 0
        || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const target = event.target instanceof Element ? event.target : null;
      const anchor = target?.closest('a[href]') ?? null;
      if (anchor === null) return;
      const absolute = isExternalHttpsHref(anchor.getAttribute('href') ?? '', window.location.origin);
      if (absolute === null) return;
      event.preventDefault();
      invoke(EXTERNAL_OPEN_COMMAND, { url: absolute })
        .then(() => setError(null))
        .catch((cause: unknown) => setError(externalOpenMessage(cause, t)));
    };
    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
  }, [t]);

  if (error === null) return null;
  return (
    <div className="fixed inset-x-0 top-3 z-50 flex justify-center px-4">
      <OutcomeMessageBar className="max-w-[36rem]" onDismiss={() => setError(null)}>{error}</OutcomeMessageBar>
    </div>
  );
}

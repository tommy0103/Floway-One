import { useSyncExternalStore } from 'react';
import { isRouteErrorResponse } from 'react-router';

import { fluentComponents } from '../fluent';
import { LocalizedError } from '../i18n/localized-error';
import { useTranslation } from '../i18n/translation';
import { useSourceMappedStack } from '../lib/source-mapped-stack';
import { ErrorShell, ErrorStack } from './ui/error-shell';
import { AppLoadingScreen } from './ui/loading-screen';

const { Button, Spinner } = fluentComponents;

// The prerendered HTML carries HydrateFallback's boot screen, so rendering the
// error tree during hydration itself is a mismatch React recovers from by
// rebuilding the page. Hydrating the fallback and showing the failure on the
// next pass keeps that exchange one React handles.
const subscribeNever = () => () => {};
const isClient = () => true;
const isServer = () => false;
export function FlowayErrorBoundary({ error }: { error: unknown }) {
  const { t } = useTranslation();
  const hydrated = useSyncExternalStore(subscribeNever, isClient, isServer);
  let message = t('common.errors.unexpectedTitle');
  let details = t('common.errors.unexpectedDescription');
  let rawStack: string | undefined;

  if (isRouteErrorResponse(error)) {
    message = error.status === 404 ? '404' : t('common.errors.title');
    details =
      error.status === 404
        ? t('common.errors.notFound')
        : error.statusText || details;
  } else if (error instanceof Error) {
    if (error instanceof LocalizedError) {
      details = t(error.translationKey);
      rawStack = error.stackWithMessage(details);
    } else {
      details = error.message;
      rawStack = error.stack;
    }
  }

  const restoration = useSourceMappedStack(rawStack);

  if (!hydrated) return <AppLoadingScreen label={t('common.loading')} />;

  const stack = restoration.stack;
  // While the trace is the minified one, the sentence the trace replaced is
  // given over to saying so. The row is declared on a span of our own: Fluent's
  // Text carries a `display` atom of the same weight, and Griffel injects at
  // runtime, so a rule on the Text itself always loses the tie.
  const note = restoration.status === 'loading'
    ? (
        <span className="inline-flex items-center gap-2 align-middle">
          {/* The message slot is a paragraph, which may hold no `div`. */}
          <Spinner as="span" size="tiny" />
          {t('common.errors.sourceMapLoading')}
        </span>
      )
    : restoration.status === 'failed'
      ? t('common.errors.sourceMapFailed')
      : undefined;

  return (
    <ErrorShell
      action={
        <>
          {/* A reload, not a router navigation: whatever failed may have left
              app state or modules in a shape a navigation would keep. */}
          <Button appearance="primary" onClick={() => window.location.reload()}>
            {t('common.errors.refresh')}
          </Button>
          <Button onClick={() => window.history.back()}>{t('common.errors.back')}</Button>
        </>
      }
      message={stack ? note : details}
      title={message}
    >
      {stack && <ErrorStack>{stack}</ErrorStack>}
    </ErrorShell>
  );
}

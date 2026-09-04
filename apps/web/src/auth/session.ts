export const flowayTokenStorageKey = 'floway-token';
export const flowaySessionHeader = 'x-floway-session';
export const personalDashboardBootstrapFragmentKey = 'floway-bootstrap';

const sessionInvalidatedEvent = 'floway-session-invalidated';

// Guards the build-time prerender pass, which has no DOM. Storage switched off
// is deliberately unguarded: a session that cannot persist should throw.
const hasWindow = (): boolean => typeof window !== 'undefined';

export const getSessionToken = (): string | null => {
  if (!hasWindow()) return null;
  return window.localStorage.getItem(flowayTokenStorageKey);
};

export const setSessionToken = (token: string): void => {
  if (!hasWindow()) return;
  window.localStorage.setItem(flowayTokenStorageKey, token);
};

export const clearSessionToken = (): void => {
  if (!hasWindow()) return;
  window.localStorage.removeItem(flowayTokenStorageKey);
};

export const invalidateSession = (expectedToken: string | null): void => {
  if (getSessionToken() !== expectedToken) return;
  clearSessionToken();
  if (!hasWindow()) return;
  window.dispatchEvent(new Event(sessionInvalidatedEvent));
};

export const onSessionInvalidated = (listener: () => void): (() => void) => {
  if (!hasWindow()) return () => undefined;
  window.addEventListener(sessionInvalidatedEvent, listener);
  return () => window.removeEventListener(sessionInvalidatedEvent, listener);
};

export const takePersonalDashboardBootstrapToken = (): string | null => {
  if (!hasWindow()) return null;
  const parameters = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  const token = parameters.get(personalDashboardBootstrapFragmentKey);
  if (token === null) return null;

  parameters.delete(personalDashboardBootstrapFragmentKey);
  const remainingFragment = parameters.size === 0 ? '' : `#${parameters.toString()}`;
  window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}${remainingFragment}`);
  return token;
};

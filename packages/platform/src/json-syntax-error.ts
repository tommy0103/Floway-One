export const secretSafeJsonSyntaxError = (cause: unknown, message: string): SyntaxError => {
  const sanitized = new SyntaxError(message);
  if (!(cause instanceof SyntaxError)) return sanitized;

  for (const property of ['code', 'position'] as const) {
    const descriptor = Object.getOwnPropertyDescriptor(cause, property);
    if (descriptor === undefined || !('value' in descriptor)) continue;
    if (typeof descriptor.value !== 'string' && typeof descriptor.value !== 'number') continue;
    Object.defineProperty(sanitized, property, {
      configurable: true,
      enumerable: descriptor.enumerable,
      value: descriptor.value,
      writable: true,
    });
  }
  return sanitized;
};

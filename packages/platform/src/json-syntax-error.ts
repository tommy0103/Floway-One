export const secretSafeJsonSyntaxError = (cause: unknown, message: string): SyntaxError => {
  if (!(cause instanceof SyntaxError)) return new SyntaxError(message);

  const sanitized = new SyntaxError(message);
  // JSON parser messages can embed the input. Preserve only original stack
  // frames and numeric location metadata; never retain the raw message,
  // non-frame stack fragments, arbitrary properties, or Error object.
  const frames = cause.stack
    ?.split(/\r?\n/u)
    .slice(1)
    .filter(line => /^\s+at\s/u.test(line));
  if (frames !== undefined && frames.length > 0) {
    Object.defineProperty(sanitized, 'stack', {
      configurable: true,
      value: `${sanitized.name}: ${sanitized.message}\n${frames.join('\n')}`,
      writable: true,
    });
  }

  for (const property of ['columnNumber', 'lineNumber', 'position'] as const) {
    const descriptor = Object.getOwnPropertyDescriptor(cause, property);
    if (descriptor === undefined || !('value' in descriptor)) continue;
    if (typeof descriptor.value !== 'number' || !Number.isSafeInteger(descriptor.value) || descriptor.value < 0) continue;
    Object.defineProperty(sanitized, property, {
      configurable: true,
      enumerable: descriptor.enumerable,
      value: descriptor.value,
      writable: true,
    });
  }
  const location = /\bposition\s+(\d+)(?:\s+\(line\s+(\d+)\s+column\s+(\d+)\))?/u.exec(cause.message);
  for (const [property, raw] of [
    ['position', location?.[1]],
    ['lineNumber', location?.[2]],
    ['columnNumber', location?.[3]],
  ] as const) {
    if (raw === undefined || Object.hasOwn(sanitized, property)) continue;
    Object.defineProperty(sanitized, property, {
      configurable: true,
      value: Number(raw),
      writable: true,
    });
  }
  const code = Object.getOwnPropertyDescriptor(cause, 'code');
  if (code !== undefined && 'value' in code && typeof code.value === 'string' && /^[A-Z][A-Z0-9_]*$/u.test(code.value)) {
    Object.defineProperty(sanitized, 'code', {
      configurable: true,
      enumerable: code.enumerable,
      value: code.value,
      writable: true,
    });
  }
  return sanitized;
};

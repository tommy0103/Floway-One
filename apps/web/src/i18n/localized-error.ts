import type { TranslationKeyWithoutValues } from './translation';

export class LocalizedError extends Error {
  constructor(readonly translationKey: TranslationKeyWithoutValues, options?: ErrorOptions) {
    super(translationKey, options);
    this.name = 'LocalizedError';
  }

  stackWithMessage(message: string): string | undefined {
    if (this.stack === undefined) return undefined;
    const firstFrame = this.stack.indexOf('\n');
    return `${this.name}: ${message}${firstFrame === -1 ? '' : this.stack.slice(firstFrame)}`;
  }
}

import { en, type MessageKey } from '@intafaced/i18n/catalog';

export function publishedCopy(key: string): string | null {
  const value = en[key as MessageKey];
  return typeof value === 'string' ? value : null;
}

import { formatBytes } from '../reports/model';
import type { applicationCopy } from './application-copy';
import type { Checklist } from './application-api';

type T = ReturnType<typeof applicationCopy.useCopy>['t'];

/** Checked before anything is sent: the owner's size limit and accepted kinds of file. Null means the file may go. */
export function fileProblem(file: { size: number; type: string }, rules: NonNullable<Checklist['uploadRules']>, t: T): string | null {
  if (file.size < 1) return t('emptyFile');
  if (!rules.contentTypes.some((type) => type.toLowerCase() === file.type.toLowerCase()))
    return t('wrongType', { types: kindsOf(rules.contentTypes) });
  if (file.size > rules.maxBytes) {
    const [size, limit] = [formatBytes(String(file.size)), formatBytes(String(rules.maxBytes))];
    // Just over the limit both round to the same figure, so say it in bytes.
    return size === limit ? t('tooLarge', { size: `${file.size} B`, limit: `${rules.maxBytes} B` }) : t('tooLarge', { size, limit });
  }
  return null;
}
export const kindsOf = (types: readonly string[]) => types.map((type) => (type.split('/')[1] ?? type).toUpperCase()).join(', ');

/** A file's bytes as base64, read in pieces so a large file never overflows the call stack. */
export async function base64Of(file: Blob): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

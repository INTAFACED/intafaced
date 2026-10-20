/**
 * The shape of a drop-in language file (`src/locales/<code>.json`).
 *
 * `provenance` says who wrote the words: `human` for a person's translation, `machine` for one produced by a program and not
 * yet reviewed. A machine file may say so on screen; `reviewedAt` is the date a person last read it, or `null`.
 */
export type Provenance = 'human' | 'machine';

export interface LocaleFile {
  readonly meta: { readonly provenance: Provenance; readonly reviewedAt: string | null };
  readonly messages: Readonly<Record<string, unknown>>;
}

export const PROVENANCES: readonly Provenance[] = ['human', 'machine'];

import { localeProvenance } from '@intafaced/i18n';
import { customerCopyCoverage } from './i18n';
import { uiLocales, type UiLocale } from './locale';

export type LanguageOption = {
  code: UiLocale;
  nativeName: string;
  englishName: string;
  /** Strings written in this language out of all the app's strings, rounded down: `0`, `<1`, or a whole number. Never rounded up. */
  share: string;
  written: boolean;
  /** `machine` when the words came from a program and no person has read them; `human`; `null` for English and for a language with no file. */
  provenance: 'human' | 'machine' | null;
};

/** How much of the app is written in a language, measured from the registered copy and never claimed. English is the source. */
export function writtenShare(code: UiLocale): { translated: number; total: number; label: string } {
  const rows = customerCopyCoverage(code);
  if (code === 'en') return { translated: 1, total: 1, label: '100' };
  const total = rows.reduce((sum, row) => sum + row.total, 0);
  const translated = rows.reduce((sum, row) => sum + row.translated, 0);
  if (total === 0 || translated === 0) return { translated, total, label: '0' };
  const percent = (translated * 100) / total;
  return { translated, total, label: percent < 1 ? '<1' : String(Math.floor(percent)) };
}

/** Every language the app declares: those with written copy first (English, then by native name), then the rest in registry order. */
export function languageOptions(): { written: LanguageOption[]; unwritten: LanguageOption[] } {
  const written: LanguageOption[] = [];
  const unwritten: LanguageOption[] = [];
  for (const entry of uiLocales) {
    const code = entry.code as UiLocale;
    const share = writtenShare(code);
    const option: LanguageOption = {
      code,
      nativeName: entry.nativeName,
      englishName: entry.englishName,
      share: share.label,
      written: code === 'en' || share.translated > 0,
      provenance: code === 'en' ? null : localeProvenance(code),
    };
    (option.written ? written : unwritten).push(option);
  }
  written.sort((a, b) => (a.code === 'en' ? -1 : b.code === 'en' ? 1 : a.nativeName.localeCompare(b.nativeName)));
  return { written, unwritten };
}

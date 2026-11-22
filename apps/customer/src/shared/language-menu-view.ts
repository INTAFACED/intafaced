import { useMemo } from 'react';
import { uiDirection, uiLocaleDescriptor, type UiLocale } from './locale';
import { useCopyRevision } from './i18n';
import { languageOptions, writtenShare, type LanguageOption } from './language-options';
import { languageMenuCopy } from './language-menu-copy';
import { usePreferences } from './preferences';

export interface LanguageMenuOption {
  code: string;
  text: string;
  dir: 'ltr' | 'rtl';
}
export interface LanguageMenuWords {
  text: string;
  lang: UiLocale;
}
export interface LanguageMenuView {
  label: LanguageMenuWords;
  value: UiLocale;
  /** Languages with written copy first, then those that show English and stay a stored preference (absent when none). */
  groups: { key: 'written' | 'unwritten'; label: string; lang: UiLocale; options: LanguageMenuOption[] }[];
  /** How much of the app the chosen language covers. */
  note: LanguageMenuWords;
  /** Present when the chosen language's copy is machine-translated. */
  machine?: LanguageMenuWords;
  /** Present unless the choice is kept in the account: where it is kept instead. */
  kept?: LanguageMenuWords;
}

/** One option line: the language's own name, how much of the app is written in it and, where it applies, the machine-translation tag. */
function optionText(option: LanguageOption, t: typeof languageMenuCopy.t): string {
  if (option.code === 'en') return option.nativeName;
  const parts = [option.nativeName];
  if (option.written) parts.push(t('optionShare', { share: option.share }));
  if (option.written && option.provenance === 'machine') parts.push(t('machine'));
  return parts.join(' · ');
}

/** What the interface-language picker says and offers; shared/LanguageMenu draws it in the old look, the sign-in room from the kit. */
export function useLanguageMenu(keptIn: 'browser' | 'account' | 'not-saved'): LanguageMenuView {
  const { language } = usePreferences();
  const revision = useCopyRevision();
  const { t, languageFor } = languageMenuCopy.useCopy();
  const options = useMemo(() => languageOptions(), [revision]);
  const current = [...options.written, ...options.unwritten].find((option) => option.code === language);
  const descriptor = uiLocaleDescriptor(language);
  const share = writtenShare(language);
  const noteKey =
    language === 'en' ? 'noteEnglish' : !current?.written ? 'noteUnwritten' : share.translated === share.total ? 'noteAll' : 'noteWritten';
  const note =
    noteKey === 'noteEnglish'
      ? t(noteKey)
      : noteKey === 'noteUnwritten'
        ? t(noteKey, { language: descriptor.nativeName })
        : noteKey === 'noteAll'
          ? t(noteKey, { language: descriptor.nativeName })
          : t(noteKey, { language: descriptor.nativeName, share: share.label });
  const line = (option: LanguageOption): LanguageMenuOption => ({
    code: option.code,
    text: optionText(option, t),
    dir: uiDirection(option.code),
  });
  const groups: LanguageMenuView['groups'] = [
    { key: 'written', label: t('groupWritten'), lang: languageFor('groupWritten'), options: options.written.map(line) },
  ];
  if (options.unwritten.length > 0)
    groups.push({
      key: 'unwritten',
      label: t('groupUnwritten'),
      lang: languageFor('groupUnwritten'),
      options: options.unwritten.map(line),
    });
  const keptKey = keptIn === 'browser' ? 'noteDevice' : 'noteNotSaved';
  return {
    label: { text: t('label'), lang: languageFor('label') },
    value: language,
    groups,
    note: { text: note, lang: languageFor(noteKey) },
    ...(current?.written && current.provenance === 'machine'
      ? { machine: { text: t('noteMachine'), lang: languageFor('noteMachine') } }
      : {}),
    ...(keptIn !== 'account' ? { kept: { text: t(keptKey), lang: languageFor(keptKey) } } : {}),
  };
}

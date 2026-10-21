import { useId, useMemo } from 'react';
import { canonicalUiLocale, uiDirection, uiLocaleDescriptor, type UiLocale } from './locale';
import { useCopyRevision } from './i18n';
import { languageOptions, writtenShare, type LanguageOption } from './language-options';
import { languageMenuCopy } from './language-menu-copy';
import { usePreferences } from './preferences';
import './language-menu.css';

/** One option line: the language's own name, how much of the app is written in it and, where it applies, the machine-translation tag. */
function optionText(option: LanguageOption, t: typeof languageMenuCopy.t): string {
  if (option.code === 'en') return option.nativeName;
  const parts = [option.nativeName];
  if (option.written) parts.push(t('optionShare', { share: option.share }));
  if (option.written && option.provenance === 'machine') parts.push(t('machine'));
  return parts.join(' · ');
}

/**
 * The interface-language picker. `onSelect` stores the choice; this component only reads the device copy. Every declared language is
 * listed: those with written copy first with their measured share, the rest under a group that says they show English and stay a
 * stored preference. `keptIn` says where the choice is kept: this browser only (signed out), the account, or this device because the
 * account could not be written.
 */
export function LanguageMenu({
  onSelect,
  keptIn,
  className,
}: {
  onSelect: (language: UiLocale) => void;
  keptIn: 'browser' | 'account' | 'not-saved';
  className?: string;
}) {
  const id = useId();
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
  const render = (option: LanguageOption) => (
    <option key={option.code} value={option.code} lang={option.code} dir={uiDirection(option.code)}>
      {optionText(option, t)}
    </option>
  );
  return (
    <div className={className ? `language-menu ${className}` : 'language-menu'} data-language-menu>
      <label htmlFor={id} lang={languageFor('label')}>
        {t('label')}
      </label>
      <select
        id={id}
        value={language}
        onChange={(event) => {
          const next = canonicalUiLocale(event.target.value);
          if (next) onSelect(next);
        }}
      >
        <optgroup label={t('groupWritten')} lang={languageFor('groupWritten')}>
          {options.written.map(render)}
        </optgroup>
        {options.unwritten.length > 0 && (
          <optgroup label={t('groupUnwritten')} lang={languageFor('groupUnwritten')}>
            {options.unwritten.map(render)}
          </optgroup>
        )}
      </select>
      <small data-language-note lang={languageFor(noteKey)}>
        {note}
      </small>
      {current?.written && current.provenance === 'machine' && (
        <small data-language-machine lang={languageFor('noteMachine')}>
          {t('noteMachine')}
        </small>
      )}
      {keptIn !== 'account' && (
        <small data-language-kept={keptIn} lang={languageFor(keptIn === 'browser' ? 'noteDevice' : 'noteNotSaved')}>
          {t(keptIn === 'browser' ? 'noteDevice' : 'noteNotSaved')}
        </small>
      )}
    </div>
  );
}

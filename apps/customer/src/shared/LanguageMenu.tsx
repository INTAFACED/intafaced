import { useId } from 'react';
import { canonicalUiLocale, type UiLocale } from './locale';
import { useLanguageMenu, type LanguageMenuOption } from './language-menu-view';
import './language-menu.css';

/**
 * The interface-language picker. `onSelect` stores the choice; this component only reads the device copy. Every declared language is
 * listed: those with written copy first with their measured share, the rest under a group that says they show English and stay a
 * stored preference. `keptIn` says where the choice is kept: this browser only (signed out), the account, or this device because the
 * account could not be written. Its words and choices are `useLanguageMenu` (language-menu-view.ts), which the sign-in room draws
 * from the kit.
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
  const menu = useLanguageMenu(keptIn);
  const render = (option: LanguageMenuOption) => (
    <option key={option.code} value={option.code} lang={option.code} dir={option.dir}>
      {option.text}
    </option>
  );
  return (
    <div className={className ? `language-menu ${className}` : 'language-menu'} data-language-menu>
      <label htmlFor={id} lang={menu.label.lang}>
        {menu.label.text}
      </label>
      <select
        id={id}
        value={menu.value}
        onChange={(event) => {
          const next = canonicalUiLocale(event.target.value);
          if (next) onSelect(next);
        }}
      >
        {menu.groups.map((group) => (
          <optgroup key={group.key} label={group.label} lang={group.lang}>
            {group.options.map(render)}
          </optgroup>
        ))}
      </select>
      <small data-language-note lang={menu.note.lang}>
        {menu.note.text}
      </small>
      {menu.machine && (
        <small data-language-machine lang={menu.machine.lang}>
          {menu.machine.text}
        </small>
      )}
      {menu.kept && (
        <small data-language-kept={keptIn} lang={menu.kept.lang}>
          {menu.kept.text}
        </small>
      )}
    </div>
  );
}

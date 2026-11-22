import { Select } from '@intafaced/ui/lit';
import { canonicalUiLocale, type UiLocale } from '../../shared/locale';
import { useLanguageMenu } from '../../shared/language-menu-view';

/**
 * The sign-in room's interface-language picker, drawn from the kit: the same choices and notes as the app's language menu
 * (shared/LanguageMenu), and the same `data-language-*` hooks.
 */
export function AuthLanguage({
  onSelect,
  keptIn,
}: {
  onSelect: (language: UiLocale) => void;
  keptIn: 'browser' | 'account' | 'not-saved';
}) {
  const menu = useLanguageMenu(keptIn);
  return (
    <div data-language-menu>
      <Select
        label={menu.label.text}
        value={menu.value}
        onChange={(value) => {
          const next = canonicalUiLocale(value);
          if (next) onSelect(next);
        }}
      >
        {menu.groups.map((group) => (
          <optgroup key={group.key} label={group.label} lang={group.lang}>
            {group.options.map((option) => (
              <option key={option.code} value={option.code} lang={option.code} dir={option.dir}>
                {option.text}
              </option>
            ))}
          </optgroup>
        ))}
      </Select>
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

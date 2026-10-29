import { useId, type ReactNode } from 'react';

/**
 * A tab list with real tab semantics (role=tablist, tab, tabpanel) for the Tokens room and the token page: each panel is
 * named by its tab, and only the open panel is drawn. Arrow keys move between tabs.
 */
export function TabList<T extends string>({
  label,
  tabs,
  value,
  onChange,
  children,
}: {
  label: string;
  tabs: readonly { id: T; label: string }[];
  value: T;
  onChange: (id: T) => void;
  children: ReactNode;
}) {
  const base = useId();
  const move = (step: number) => {
    const index = tabs.findIndex((tab) => tab.id === value);
    const next = tabs[(index + step + tabs.length) % tabs.length]!;
    onChange(next.id);
    document.getElementById(`${base}-tab-${next.id}`)?.focus();
  };
  return (
    <>
      <div role="tablist" aria-label={label} className="tokens-tabs">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            id={`${base}-tab-${tab.id}`}
            aria-selected={tab.id === value}
            aria-controls={`${base}-panel`}
            tabIndex={tab.id === value ? 0 : -1}
            className={tab.id === value ? 'selected' : ''}
            onClick={() => onChange(tab.id)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowRight') move(1);
              else if (event.key === 'ArrowLeft') move(-1);
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`${base}-panel`} aria-labelledby={`${base}-tab-${value}`} className="tokens-panel">
        {children}
      </div>
    </>
  );
}

import { useId, type ReactNode } from 'react';

/**
 * A tab list with real tab semantics (role=tablist, tab, tabpanel) for the Tokens room and the token page: each panel is
 * named by its tab, and only the open panel is drawn. Arrow keys (in reading order), Home and End move between tabs.
 * The shared `Tabs` stays a group of pressed buttons, which other rooms and their journey tests rely on.
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
  const go = (index: number) => {
    const next = tabs[(index + tabs.length) % tabs.length]!;
    onChange(next.id);
    document.getElementById(`${base}-tab-${next.id}`)?.focus();
  };
  const current = tabs.findIndex((tab) => tab.id === value);
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
              // Arrows follow the reading direction: in a right-to-left language the next tab is to the left.
              const forward = getComputedStyle(event.currentTarget).direction === 'rtl' ? 'ArrowLeft' : 'ArrowRight';
              const back = forward === 'ArrowLeft' ? 'ArrowRight' : 'ArrowLeft';
              if (event.key === forward) go(current + 1);
              else if (event.key === back) go(current - 1);
              else if (event.key === 'Home') go(0);
              else if (event.key === 'End') go(tabs.length - 1);
              else return;
              event.preventDefault();
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

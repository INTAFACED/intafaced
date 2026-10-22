'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { COPY_LINK_ID, paletteEntries, searchPalette, type PaletteEntry } from '@/lib/command-palette';
import type { ModuleId } from '@/lib/modules';
import './command-palette.css';

/**
 * Ctrl or Cmd K anywhere in the console, or the Search button in the top bar. Type to filter pages and actions, arrows to
 * move, Enter to open, Escape to close. `modules` is the server's list of enabled console modules, so nothing the person
 * cannot open is listed.
 */
export function CommandPalette({ modules }: { modules: readonly ModuleId[] }) {
  const router = useRouter();
  const entries = useMemo(() => paletteEntries(modules), [modules]);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [notice, setNotice] = useState('');
  const [ready, setReady] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const isOpen = useRef(false);
  isOpen.current = open;
  const results = useMemo(() => searchPalette(entries, query), [entries, query]);

  useEffect(() => {
    setReady(true);
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'k') {
        // A native modal dialog owns the screen (and the top layer); the palette would open beneath it, unreachable.
        if (document.querySelector('dialog[open]')) return;
        event.preventDefault();
        if (!isOpen.current) opener.current = document.activeElement as HTMLElement | null;
        setOpen(!isOpen.current);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  useEffect(() => {
    if (open) {
      setQuery('');
      setActive(0);
      setNotice('');
      input.current?.focus();
    } else {
      opener.current?.focus?.();
    }
  }, [open]);

  async function choose(entry: PaletteEntry | undefined) {
    if (!entry) return;
    if (entry.id === `action:${COPY_LINK_ID}`) {
      try {
        await navigator.clipboard.writeText(location.href);
        setNotice('Link copied.');
      } catch {
        setNotice('The browser did not allow copying. The address is in the address bar.');
      }
      return;
    }
    setOpen(false);
    if (entry.href) router.push(entry.href);
  }

  return (
    <>
      <button
        type="button"
        className="adm-btn adm-btn--compact adm-palette-open"
        onClick={(event) => {
          opener.current = event.currentTarget;
          setOpen(true);
        }}
        aria-keyshortcuts="Control+K Meta+K"
        disabled={!ready}
        title={ready ? undefined : 'Search is connecting.'}
      >
        Search <kbd>Ctrl K</kbd>
      </button>
      {open && (
        <div className="adm-palette-backdrop" onMouseDown={() => setOpen(false)}>
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Go to a page or action"
            className="adm-palette"
            data-testid="command-palette"
            onMouseDown={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              // Wherever focus is inside the panel, Escape closes it, and Tab stays on the search field (the one control here).
              if (event.key === 'Escape') {
                event.preventDefault();
                setOpen(false);
              } else if (event.key === 'Tab') {
                event.preventDefault();
                input.current?.focus();
              }
            }}
          >
            <input
              ref={input}
              className="adm-input"
              role="combobox"
              aria-expanded="true"
              aria-controls="adm-palette-list"
              aria-activedescendant={results[active] ? `adm-palette-${active}` : undefined}
              aria-autocomplete="list"
              placeholder="Type a page or an action"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setActive(0);
                setNotice('');
              }}
              onKeyDown={(event) => {
                if (event.key === 'ArrowDown') {
                  event.preventDefault();
                  setActive((i) => (results.length === 0 ? 0 : (i + 1) % results.length));
                } else if (event.key === 'ArrowUp') {
                  event.preventDefault();
                  setActive((i) => (results.length === 0 ? 0 : (i - 1 + results.length) % results.length));
                } else if (event.key === 'Enter') {
                  event.preventDefault();
                  void choose(results[active]);
                }
              }}
            />
            <ul id="adm-palette-list" role="listbox" aria-label="Matches" className="adm-palette-list">
              {results.map((entry, i) => (
                <li
                  key={entry.id}
                  id={`adm-palette-${i}`}
                  role="option"
                  aria-selected={i === active}
                  data-kind={entry.kind}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => void choose(entry)}
                >
                  <span className="adm-palette-label">{entry.label}</span>
                  <span className="adm-palette-hint">
                    {entry.kind === 'action' ? 'Action · ' : ''}
                    {entry.hint}
                  </span>
                </li>
              ))}
            </ul>
            {results.length === 0 && (
              <p className="adm-palette-empty" role="status">
                No page or action matches “{query}”.
              </p>
            )}
            {notice && (
              <p className="adm-palette-empty" role="status">
                {notice}
              </p>
            )}
          </div>
        </div>
      )}
    </>
  );
}

'use client';
import { useEffect, useRef, useState } from 'react';
import { SCREENS } from '@/lib/founder-ops/screens';

export function PageFinder() {
  const dialog = useRef<HTMLDialogElement>(null);
  const [query, setQuery] = useState('');
  const [ready, setReady] = useState(false);
  // Ctrl K belongs to the console-wide command palette, which lists these pages too; this button stays for the merchant desk.
  useEffect(() => setReady(true), []);
  return (
    <>
      <button
        className="mp-btn"
        type="button"
        disabled={!ready}
        title={ready ? undefined : 'Page search is connecting.'}
        onClick={() => dialog.current?.showModal()}
      >
        Find page
      </button>
      <dialog className="fo-dialog" ref={dialog}>
        <form method="dialog">
          <button className="mp-btn" aria-label="Close page search">
            Close
          </button>
        </form>
        <label className="mp-field">
          Find a founder page
          <input className="mp-input" value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
        <nav aria-label="Founder page search" className="fo-directory">
          {[
            { route: '/merchants', title: 'Overview' },
            { route: '/merchants/all', title: 'All merchants' },
            { route: '/merchants/approvals', title: 'Approvals queue' },
            { route: '/merchants/treasury', title: 'Treasury and halts' },
            { route: '/conversion/venues', title: 'Venue registry' },
            { route: '/conversion/networks', title: 'Settlement networks' },
            { route: '/conversion/wallets', title: 'Wallet routes' },
            ...SCREENS.filter((s) => !s.route.includes(':')),
          ]
            .filter((s) => s.title.toLowerCase().includes(query.toLowerCase()))
            .map((s) => (
              <a key={s.route} href={s.route}>
                {s.title}
              </a>
            ))}
        </nav>
      </dialog>
    </>
  );
}

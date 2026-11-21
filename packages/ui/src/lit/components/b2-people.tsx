/**
 * QuickSend: a row of the people someone sends to most, each a round avatar with their name under it, after one key
 * that adds a new person. Names come from the person's own saved recipients; the row draws no photo it was not given,
 * so a person with none shows their initials. Each avatar opens its send flow (`href`).
 */
import * as React from 'react';

export interface Person {
  id: string;
  name: string;
  href: string;
}

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => ([...w][0] ?? '').toUpperCase())
    .join('');

export function QuickSend({ label, people, add }: { label: string; people: readonly Person[]; add?: { label: string; href: string } }) {
  return (
    <nav className="lt-people" aria-label={label}>
      <ul>
        {add ? (
          <li>
            <a className="lt-person" data-add="" href={add.href}>
              <span className="lt-person-face" aria-hidden="true">
                <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round">
                  <path d="M12 5v14M5 12h14" />
                </svg>
              </span>
              <span className="lt-person-name">{add.label}</span>
            </a>
          </li>
        ) : null}
        {people.map((p) => (
          <li key={p.id}>
            <a className="lt-person" href={p.href}>
              <span className="lt-person-face" aria-hidden="true">
                {initials(p.name)}
              </span>
              <span className="lt-person-name">{p.name}</span>
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

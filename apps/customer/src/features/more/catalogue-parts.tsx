import type { ReactNode } from 'react';
import { Button } from '@intafaced/ui/lit';
import { Text } from './copy';

/**
 * The More rooms' shared form and list parts (`./common`'s Select, TextArea, Limit and Details) for the catalogue rooms
 * on the kit (intafaced issue 9566): the same controls, words and order, drawn only from the kit's `lt-` classes.
 */
export function Select({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: readonly (string | { value: string; label: string })[];
}) {
  return (
    <label className="lt-field">
      <span>{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => (
          <option key={typeof o === 'string' ? o : o.value} value={typeof o === 'string' ? o : o.value}>
            {typeof o === 'string' ? o : o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export function TextArea({
  label,
  value,
  onChange,
  maxLength = 10000,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  maxLength?: number;
}) {
  return (
    <label className="lt-field">
      <span>{label}</span>
      <textarea value={value} onChange={(e) => onChange(e.target.value)} maxLength={maxLength} rows={5} />
    </label>
  );
}

/** How many rows one read returned, against the limit asked for, and a wider read while the service's cap allows one. */
export function Limit({ count, limit, cap, onChange }: { count: number; limit: number; cap: number; onChange: (limit: number) => void }) {
  return (
    <div className="lt-toolbar">
      <small className="lt-hint">
        <Text k="common.showing" />
        {count}
        <Text k="common.requested.limit" />
        {limit}
        <Text k="common.this.service.publishes.no.continuation.cursor" />
      </small>
      {count >= limit && limit < cap ? (
        <Button tone="secondary" onClick={() => onChange(Math.min(cap, limit + 50))}>
          <Text k="common.load.a.larger.window" />
        </Button>
      ) : count >= cap ? (
        <small className="lt-hint">
          <Text k="common.the.published.limit.is" />
          {cap}
          <Text k="common.older.rows.cannot.be.requested.here" />
        </small>
      ) : null}
    </div>
  );
}

/** Label and value rows. A value is a node, so a row keeps the hooks a journey finds it by. */
export function Details({ items }: { items: readonly [string, ReactNode][] }) {
  return (
    <dl className="lt-kv">
      {items.map(([label, value], index) => (
        <div key={index}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

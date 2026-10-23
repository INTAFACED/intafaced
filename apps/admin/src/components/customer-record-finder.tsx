'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { customerId } from '@/lib/customer-record/tabs';

/** Opens one customer's record by account id. An id that is not an account id is refused here, before anything is read. */
export function CustomerRecordFinder() {
  const router = useRouter();
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="adm-callout"
      data-tone="info"
      aria-labelledby="h-customer-record"
      onSubmit={(event) => {
        event.preventDefault();
        const id = customerId(value.trim());
        if (id === null) {
          setError('That is not an account id. An account id looks like 0b6f7a3e-1c2d-4e5f-8a9b-0c1d2e3f4a5b.');
          return;
        }
        setError(null);
        router.push(`/accounts/${id}`);
      }}
    >
      <strong id="h-customer-record">Customer record</strong>
      <p>One customer across money, trade, pay, cards and tickets, each read from its own service.</p>
      <label>
        Account id
        <input name="customer-id" value={value} onChange={(event) => setValue(event.target.value)} autoComplete="off" spellCheck={false} />
      </label>
      <button type="submit" className="adm-btn" data-tone="primary">
        Open customer record
      </button>
      {error && (
        <p role="alert" className="dk-muted">
          {error}
        </p>
      )}
    </form>
  );
}

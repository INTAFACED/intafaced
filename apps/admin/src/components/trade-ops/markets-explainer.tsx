'use client';

import { KeyValue } from '@intafaced/ui';

/** Halt and delist side by side, in plain words, so nobody ends a market when they meant to pause it. */
export function HaltVsDelist() {
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
      <div>
        <h3 className="mb-1 text-sm font-medium">Halt: a pause</h3>
        <KeyValue
          density="dense"
          layout="stacked"
          items={[
            { label: 'Can it be undone', value: 'Yes. Resume reopens it, with two different operators.' },
            { label: 'Resting orders', value: 'Kept on the book. They are not cancelled.' },
            { label: 'Cancels', value: 'Customers can still cancel their orders.' },
            { label: 'New orders', value: 'Refused while halted.' },
            { label: 'Funds', value: 'Stay reserved against the resting orders.' },
          ]}
        />
      </div>
      <div>
        <h3 className="mb-1 text-sm font-medium">Delist: an ending</h3>
        <KeyValue
          density="dense"
          layout="stacked"
          items={[
            { label: 'Can it be undone', value: 'No. The market ends and cannot be reopened.' },
            { label: 'Resting orders', value: 'Cancelled as part of the delisting.' },
            { label: 'Settlement', value: 'Positions are settled and withdrawals are handled.' },
            { label: 'New orders', value: 'Refused for good.' },
            { label: 'Confirmation', value: 'Two different operators, and the symbol typed back exactly.' },
          ]}
        />
      </div>
    </div>
  );
}

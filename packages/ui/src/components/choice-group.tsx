import type { ReactNode } from 'react';
import { SegmentedControl } from './segmented.js';

/** Single-choice filter; labels can be translated independently of server/URL values. */
export function ChoiceGroup({
  items,
  value,
  onChange,
  label,
  labels,
}: {
  items: readonly string[];
  value: string;
  onChange: (value: string) => void;
  label: string;
  labels?: Readonly<Record<string, ReactNode>>;
}) {
  return (
    <div className="max-w-full overflow-x-auto">
      <SegmentedControl
        size={32}
        items={items.map((value) => ({ value, label: labels?.[value] ?? value }))}
        value={value}
        onValueChange={onChange}
        aria-label={label}
      />
    </div>
  );
}

/**
 * Gallery section for Input and Field. TEST DATA only: every value is made-up sample text.
 * The decimal demos use real state, so you can type, paste and press the arrow keys; the
 * "value:" line under each shows the exact raw string, so a lost digit would be visible.
 */
import * as React from 'react';
import { Search } from 'lucide-react';
import { Field } from '../../field.js';
import { Input } from '../../input.js';

const DENSITIES = ['dense', 'comfortable'] as const;

function Part({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-3">
      <h3 className="text-sm font-medium text-fg-2">{title}</h3>
      {children}
    </div>
  );
}

function Caption({ children }: { children: React.ReactNode }) {
  return <span className="text-2xs text-fg-2">{children}</span>;
}

const noop = () => {};

/** One labelled cell of the states grid. */
function Cell({ caption, children }: { caption: string; children: React.ReactNode }) {
  return (
    <div className="flex w-64 flex-col gap-1.5">
      <Caption>{caption}</Caption>
      {children}
    </div>
  );
}

/** Decimal input with real state and a line showing the exact raw string. */
function LiveDecimal({
  label,
  density,
  precision,
  tick,
  initial,
  unit,
  decimalSeparator,
}: {
  label: string;
  density: 'dense' | 'comfortable';
  precision: number;
  tick?: string;
  initial: string;
  unit: string;
  decimalSeparator?: '.' | ',';
}) {
  const [value, setValue] = React.useState(initial);
  return (
    <div className="flex w-72 flex-col gap-1.5">
      <Field label={label} density={density} hint={`Up to ${precision} decimals${tick ? `, arrow keys step ${tick}` : ''}`}>
        <Input
          kind="decimal"
          value={value}
          onValueChange={setValue}
          precision={precision}
          tick={tick}
          decimalSeparator={decimalSeparator}
          trailing={unit}
          placeholder="0"
        />
      </Field>
      <span className="if-num break-all text-2xs text-fg-2" data-testid="raw-value">
        value: {value === '' ? '(empty)' : value}
      </span>
    </div>
  );
}

function LiveText({ density }: { density: 'dense' | 'comfortable' }) {
  const [value, setValue] = React.useState('Sample name');
  return (
    <div className="flex w-72 flex-col gap-1.5">
      <Field label="Label (text kind)" density={density} hint="Any text">
        <Input value={value} onValueChange={setValue} leading={<Search size={14} aria-hidden="true" />} />
      </Field>
      <span className="text-2xs text-fg-2">value: {value === '' ? '(empty)' : value}</span>
    </div>
  );
}

export function InputSection() {
  return (
    <section className="flex flex-col gap-6 border-t border-line py-8" data-testid="input-section">
      <h2 className="text-lg font-semibold">
        Input and Field <span className="text-warn">TEST DATA</span>
      </h2>

      {DENSITIES.map((density) => (
        <Part key={density} title={`States, text kind, ${density}`}>
          <div className="flex flex-wrap gap-6">
            <Cell caption="default (empty, placeholder)">
              <Input density={density} value="" onValueChange={noop} placeholder="Placeholder" aria-label="default" />
            </Cell>
            <Cell caption="filled">
              <Input density={density} value="Sample text" onValueChange={noop} aria-label="filled" />
            </Cell>
            <Cell caption="disabled">
              <Input density={density} value="Sample text" onValueChange={noop} disabled aria-label="disabled" />
            </Cell>
            <Cell caption="readOnly">
              <Input density={density} value="Sample text" onValueChange={noop} readOnly aria-label="readOnly" />
            </Cell>
            <Cell caption="loading (aria-busy, still editable)">
              <Input density={density} value="Sample text" onValueChange={noop} loading aria-label="loading" />
            </Cell>
            <Cell caption="invalid, icon cue (add a message through Field)">
              <Input density={density} value="Sample text" onValueChange={noop} invalid aria-label="invalid" />
            </Cell>
            <Cell caption="leading icon">
              <Input
                density={density}
                value=""
                onValueChange={noop}
                placeholder="Search"
                leading={<Search size={14} aria-hidden="true" />}
                aria-label="with icon"
              />
            </Cell>
            <Cell caption="unit text (decimal, end aligned)">
              <Input
                kind="decimal"
                density={density}
                value="125.5"
                onValueChange={noop}
                precision={2}
                trailing="USDT"
                aria-label="with unit"
              />
            </Cell>
          </div>
        </Part>
      ))}

      {DENSITIES.map((density) => (
        <Part key={density} title={`Field: label, hint, error, required, ${density}`}>
          <div className="flex flex-wrap items-start gap-6">
            <Cell caption="label + hint">
              <Field label="Display name" hint="Shown to other people" density={density}>
                <Input value="Sample name" onValueChange={noop} />
              </Field>
            </Cell>
            <Cell caption="error message (icon + text)">
              <Field label="Amount" error="Enter at least 5 USDT" hint="Minimum order" density={density}>
                <Input kind="decimal" precision={2} value="1" onValueChange={noop} trailing="USDT" />
              </Field>
            </Cell>
            <Cell caption="required (marker + sr-only word)">
              <Field label="Email" required density={density}>
                <Input value="" onValueChange={noop} placeholder="name@example.com" />
              </Field>
            </Cell>
            <Cell caption="disabled field">
              <Field label="Locked" disabled hint="Cannot be changed" density={density}>
                <Input value="Sample" onValueChange={noop} />
              </Field>
            </Cell>
            <Cell caption="labelAction (Max)">
              <Field
                label="Amount"
                density={density}
                labelAction={
                  <button type="button" className="rounded-xs text-accent-text focus-visible:outline-2 focus-visible:outline-focus">
                    Max
                  </button>
                }
              >
                <Input kind="decimal" precision={8} value="0.5" onValueChange={noop} trailing="BTC" />
              </Field>
            </Cell>
            <Cell caption="loading in a field">
              <Field label="Checking name" density={density} hint="Looking it up">
                <Input value="sample" onValueChange={noop} loading />
              </Field>
            </Cell>
          </div>
        </Part>
      ))}

      <Part title="Field, horizontal (dense desk forms)">
        <div className="flex w-120 max-w-full flex-col gap-3">
          <Field label="Price" orientation="horizontal" density="dense" hint="Tick 0.1">
            <Input kind="decimal" precision={1} value="100.5" onValueChange={noop} trailing="USDT" />
          </Field>
          <Field label="Amount" orientation="horizontal" density="dense" error="Too large" required>
            <Input kind="decimal" precision={8} value="99" onValueChange={noop} trailing="BTC" />
          </Field>
        </div>
      </Part>

      <Part title="Decimal kind, live: type, paste, arrow keys (Shift = 10 steps)">
        <div className="flex flex-wrap items-start gap-6">
          {DENSITIES.map((density) => (
            <React.Fragment key={density}>
              <LiveDecimal label={`Price (${density})`} density={density} precision={1} tick="0.1" initial="0.1" unit="USDT" />
              <LiveDecimal
                label={`Quantity, 18 decimals (${density})`}
                density={density}
                precision={18}
                initial="0.123456789012345678"
                unit="ETH"
              />
              <LiveDecimal
                label={`Comma keyboard (${density})`}
                density={density}
                precision={8}
                tick="0.00000001"
                initial="0.25"
                unit="BTC"
                decimalSeparator=","
              />
              <LiveText density={density} />
            </React.Fragment>
          ))}
          <LiveDecimal
            label="Huge integer (comfortable)"
            density="comfortable"
            precision={18}
            initial="123456789012345678901234567890.000000000000000001"
            unit="TEST"
          />
        </div>
        <Caption>
          Try: type 0.1 then arrow up twice (0.2, 0.3 exactly), paste 1,234.5678, type a 19th decimal in the 18-decimal field (refused),
          paste 0.1234567890123456789 (the last digit is cut off, not rounded).
        </Caption>
      </Part>
    </section>
  );
}

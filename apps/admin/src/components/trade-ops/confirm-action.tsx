'use client';

import { useId, useState, type ReactNode } from 'react';
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
  Button,
  Field,
  Input,
} from '@intafaced/ui';
import type { Outcome } from '@/lib/trade-ops/outcome';
import { OutcomeNotice } from './outcome-notice';

/**
 * One consequential action: say what it will do, ask for a reason (written to the audit), send once, and show the
 * result in words. No optimistic success: the dialog stays open on a refusal or an unknown result.
 * It never retries by itself: after "Result unknown" the operator must read the state again.
 */
export function ConfirmAction(props: {
  trigger: string;
  title: string;
  /** What will change on the book, in plain words. */
  consequence: ReactNode;
  confirmLabel: string;
  /** danger = red sell-style button. */
  tone?: 'default' | 'danger';
  /** Minimum reason length. 0 hides the reason field. */
  reasonMin?: number;
  triggerVariant?: 'primary' | 'secondary' | 'ghost' | 'sell';
  disabled?: boolean;
  disabledReason?: string;
  run: (reason: string) => Promise<Outcome<unknown>>;
  onDone?: (outcome: Outcome<unknown>) => void;
}) {
  const { reasonMin = 12 } = props;
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Outcome<unknown> | null>(null);
  const reasonId = useId();
  const tooShort = reasonMin > 0 && reason.trim().length < reasonMin;

  async function submit() {
    setBusy(true);
    const outcome = await props.run(reason.trim());
    setBusy(false);
    setResult(outcome);
    props.onDone?.(outcome);
  }

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (busy) return;
        setOpen(next);
        if (!next) {
          setResult(null);
          setReason('');
        }
      }}
    >
      <AlertDialogTrigger
        render={<Button size={28} variant={props.triggerVariant ?? (props.tone === 'danger' ? 'sell' : 'secondary')} shape="rounded" disabled={props.disabled} title={props.disabled ? props.disabledReason : undefined} />}
      >
        {props.trigger}
      </AlertDialogTrigger>
      <AlertDialogContent className="max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle>{props.title}</AlertDialogTitle>
          <AlertDialogDescription render={<div />}>{props.consequence}</AlertDialogDescription>
        </AlertDialogHeader>
        {reasonMin > 0 && result?.kind !== 'ok' ? (
          <Field label="Reason (kept in the audit)" hint={`At least ${reasonMin} characters.`} density="dense">
            <Input id={reasonId} value={reason} onValueChange={setReason} density="dense" />
          </Field>
        ) : null}
        {result ? <OutcomeNotice outcome={result} className="mt-4" /> : null}
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="secondary" shape="rounded" size={32} disabled={busy} />}>
            {result?.kind === 'ok' ? 'Close' : 'Cancel'}
          </AlertDialogClose>
          {result?.kind === 'ok' ? null : (
            <Button
              variant={props.tone === 'danger' ? 'sell' : 'primary'}
              shape="rounded"
              size={32}
              loading={busy}
              disabled={tooShort || result?.kind === 'unknown'}
              onClick={submit}
            >
              {props.confirmLabel}
            </Button>
          )}
        </AlertDialogFooter>
        {result?.kind === 'unknown' ? (
          <p className="mt-2 text-xs text-fg-3">Close this and read the state again before repeating the action.</p>
        ) : null}
      </AlertDialogContent>
    </AlertDialog>
  );
}

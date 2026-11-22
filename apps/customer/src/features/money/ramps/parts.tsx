import { useId, type ReactNode } from 'react';
import { Button, Field } from '@intafaced/ui/lit';
import { Sheet } from '@intafaced/ui/lit/templates';
import type { ApiResult } from '../../../shared/api';
import { useFailureWords } from '../../../shared/failure-words';
import { useWithdrawStepUp } from '../step-up';

/**
 * The ramps rooms' own parts, drawn with the kit: a panel, a failed read or change in the words
 * `Failure` uses, and the "Confirm it's you" sheet with `WithdrawStepUp`'s logic.
 */

type Failed = Extract<ApiResult<unknown>, { ok: false }>;

/** One part of the room under its heading, named by it. */
export function Panel({ title, lead, children }: { title: ReactNode; lead?: ReactNode; children: ReactNode }) {
  const heading = useId();
  return (
    <section aria-labelledby={heading}>
      <h2 id={heading}>{title}</h2>
      {lead && <p className="lt-hint">{lead}</p>}
      {children}
    </section>
  );
}

/** A failed read or change, with the same words, role, link, reference and try-again as `Failure`. */
export function FailureNote({ result, retry }: { result: Failed; retry?: () => void }) {
  const w = useFailureWords(result, Boolean(retry));
  return (
    <div data-testid="failure" role={w.alert ? 'alert' : 'status'}>
      <h3>{w.title}</h3>
      <p lang={w.bodyLang}>{w.body}</p>
      {w.action && (
        <a className="lt-link" href={w.action.href}>
          {w.action.label}
        </a>
      )}
      {w.reference && <small className="lt-hint">{w.reference}</small>}
      {w.retry && retry && (
        <Button tone="secondary" onClick={retry}>
          {w.retry}
        </Button>
      )}
    </div>
  );
}

/**
 * "Confirm it's you" for `trade:withdraw`, as `WithdrawStepUp` does it: a passkey or a code buys one short token for
 * exactly one `run`; a refusal stays in the sheet in the service's words; success closes it.
 */
export function StepUpSheet({
  why,
  run,
  onDone,
  onCancel,
}: {
  why?: string;
  run: (token: string) => Promise<ApiResult<unknown>>;
  onDone: () => void;
  onCancel: () => void;
}) {
  const s = useWithdrawStepUp({ run, onDone });
  const { t } = s;
  return (
    <Sheet
      open
      title={t('title')}
      onClose={() => {
        if (!s.busy) onCancel();
      }}
    >
      <p className="lt-hint">{why ?? t('why')}</p>
      <Button tone="secondary" disabled={s.busy !== null} onClick={s.passkey}>
        {s.busy === 'passkey' ? t('passkeyWaiting') : t('passkey')}
      </Button>
      <p className="lt-hint">{t('or')}</p>
      <form onSubmit={s.submitCode} noValidate>
        <Field
          label={t('code')}
          hint={t('codeHint')}
          name="withdraw-stepup-code"
          autoComplete="one-time-code"
          maxLength={11}
          value={s.code}
          disabled={s.busy !== null}
          onChange={(event) => s.setCode(event.target.value)}
        />
        <Button type="submit" tone="primary" disabled={s.busy !== null || s.code.length < 6}>
          {s.busy === 'code' ? t('checking') : t('confirm')}
        </Button>
      </form>
      {s.problem && (
        <p data-testid="failure" role="alert">
          {s.problem}
        </p>
      )}
      <Button tone="quiet" disabled={s.busy !== null} onClick={onCancel}>
        {t('cancel')}
      </Button>
    </Sheet>
  );
}

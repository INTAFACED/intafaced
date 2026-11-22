import { useId, type InputHTMLAttributes, type ReactNode } from 'react';
import { Button, EmptyState, Field } from '@intafaced/ui/lit';
import { Sheet, Skeleton } from '@intafaced/ui/lit/templates';
import type { ApiResult } from '../../../shared/api';
import { useFailureWords } from '../../../shared/failure-words';
import type { Resource } from '../../../shared/resource';
import { t as copyText, Text } from '../copy';
import { useWithdrawStepUp } from '../step-up';

/**
 * The Transfers room's own drawing, in the Volt kit, of the shared parts it used: `Failure` and
 * `Field` (shared/ui), `ResourceView`, `Section`, `NoRows` and `Continuation` (../components.tsx) and `WithdrawStepUp`
 * (../WithdrawStepUp.tsx). Each keeps the words, ids, roles and states of the part it stands for; the shared parts stay
 * as they are for the rooms not in Volt.
 */

type Failed = Extract<ApiResult<unknown>, { ok: false }>;

/** A failed read or change, in the words `Failure` says it. */
export function Failure({ result, retry }: { result: Failed; retry?: () => void }) {
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
      {w.reference && <small>{w.reference}</small>}
      {w.retry && retry && (
        <Button tone="secondary" onClick={retry}>
          {w.retry}
        </Button>
      )}
    </div>
  );
}

/** A labelled text input: the kit's `Field`, under the name the transfer parts already use. */
export const TextField = Field;

/** A read's three states: loading, failed with its retry, or its data. */
export function Loaded<T>({ resource, reload, children }: { resource: Resource<T>; reload: () => void; children: (data: T) => ReactNode }) {
  if (resource.status === 'loading') return <Skeleton shape="rows" />;
  if (resource.status === 'failed') return <Failure result={resource.failure} retry={reload} />;
  return <>{children(resource.data)}</>;
}

/** A titled part of the room, with its description and its actions. */
export function Part({
  title,
  description,
  actions,
  children,
}: {
  title: ReactNode;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section>
      <header>
        <div>
          <h2>{title}</h2>
          {description && <p>{description}</p>}
        </div>
        {actions && <div className="lt-actions">{actions}</div>}
      </header>
      {children}
    </section>
  );
}

export function NoRows({ title, children }: { title: string; children?: string }) {
  return <EmptyState title={title} body={children} />;
}

/** How many records came back of the limit asked, and the way to ask for more up to the service's 200. */
export function Continuation({ count, limit, onMore }: { count: number; limit: number; onMore: () => void }) {
  return (
    <div>
      <span>
        {count}
        <Text k="components.records.returned.requested.limit" />.{' '}
        {count >= limit
          ? limit < 200
            ? copyText('components.more.records.may.exist')
            : copyText('components.this.service.has.no.continuation.beyond.200')
          : copyText('components.this.list.has.no.total.count.or')}
      </span>
      {count >= limit && limit < 200 && (
        <Button tone="secondary" onClick={onMore}>
          <Text k="components.load.up.to" />
          {Math.min(200, limit + 50)}
        </Button>
      )}
    </div>
  );
}

/**
 * "Confirm it's you" for anything that needs `trade:withdraw`, as `WithdrawStepUp` asks it: a passkey, or an
 * authenticator or recovery code, buys one short token spent on `run` once. A refusal of the action stays in the sheet.
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
  const t = s.t;
  return (
    <Sheet
      open
      title={t('title')}
      onClose={() => {
        if (!s.busy) onCancel();
      }}
    >
      <div>
        <p>{why ?? t('why')}</p>
        <Button tone="secondary" disabled={s.busy !== null} onClick={s.passkey}>
          {s.busy === 'passkey' ? t('passkeyWaiting') : t('passkey')}
        </Button>
        <p>{t('or')}</p>
        <form onSubmit={s.submitCode} noValidate>
          <TextField
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
      </div>
    </Sheet>
  );
}

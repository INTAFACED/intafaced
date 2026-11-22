import { copy as legacyCopy, t as copyText, Text } from './copy';
import type { ReactNode } from 'react';
import { useActionState, type Presented } from './action-state';
import type { ApiResult } from '../../shared/api';
import type { Resource } from '../../shared/resource';
import { Button, Dialog, EmptyState, Failure, Loading } from '../../shared/ui';
import { renderAuthoredCopy } from '../../shared/i18n';
import { uiDirection } from '../../shared/locale';

export { actionFailurePresentation, presentActionFailure } from './action-state';

export function Read<T>({
  resource,
  retry,
  empty,
  children,
}: {
  resource: Resource<T>;
  retry: () => void;
  empty?: string;
  children: (data: T) => ReactNode;
}) {
  if (resource.status === 'loading') return <Loading />;
  if (resource.status === 'failed')
    return (
      <div lang="und" style={{ display: 'contents' }}>
        <Failure result={resource.failure} retry={retry} />
      </div>
    );
  if (empty && (resource.data === null || (Array.isArray(resource.data) && resource.data.length === 0)))
    return <EmptyState title={empty} />;
  return <>{children(resource.data)}</>;
}
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
    <label className="field">
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
    <label className="field">
      <span>{label}</span>
      <textarea value={value} onChange={(e) => onChange(e.target.value)} maxLength={maxLength} rows={5} />
    </label>
  );
}
export function Limit({ count, limit, cap, onChange }: { count: number; limit: number; cap: number; onChange: (limit: number) => void }) {
  return (
    <div className="more-continuation">
      <small>
        <Text k="common.showing" />
        {count}
        <Text k="common.requested.limit" />
        {limit}
        <Text k="common.this.service.publishes.no.continuation.cursor" />
      </small>
      {count >= limit && limit < cap ? (
        <Button variant="secondary" onClick={() => onChange(Math.min(cap, limit + 50))}>
          <Text k="common.load.a.larger.window" />
        </Button>
      ) : count >= cap ? (
        <small>
          <Text k="common.the.published.limit.is" />
          {cap}
          <Text k="common.older.rows.cannot.be.requested.here" />
        </small>
      ) : null}
    </div>
  );
}
export function Details({ items }: { items: readonly [string, ReactNode][] }) {
  return (
    <dl className="more-details">
      {items.map(([label, value], index) => (
        <div key={index}>
          <dt>{label}</dt>
          <dd style={{ minWidth: 0 }}>{value}</dd>
        </div>
      ))}
    </dl>
  );
}
export function PresentedCopy({ value }: { value: Presented<ReactNode> }) {
  const shown = typeof value === 'function' ? renderAuthoredCopy(value) : { value, language: 'und' };
  return (
    <span lang={shown.language} dir={shown.language === 'und' ? undefined : uiDirection(shown.language)} style={{ display: 'contents' }}>
      {shown.value}
    </span>
  );
}
export type ActionControls = Pick<ReturnType<typeof useAction>, 'stage' | 'disabled' | 'isCurrent' | 'result'>;
export function useAction(room: string, recovery?: { recover: (reference: string) => Promise<ApiResult<unknown>>; done?: () => void }) {
  const action = useActionState(room, recovery);
  const {
    userId,
    language,
    running,
    failure,
    presentation,
    copy,
    problem,
    problemKey,
    success,
    known,
    saved,
    canRecover,
    cleanup,
    recoverOriginal,
    redraw,
    reviewing,
    dismiss,
    send,
  } = action.view;
  const feedback = (
    <>
      {running ? (
        <Loading label={copyText('common.waiting.for.the.service')} />
      ) : failure ? (
        <div
          lang={problem ? legacyCopy.forLocale(language).languageFor(problemKey) : (presentation?.language ?? 'und')}
          style={{ display: 'contents' }}
        >
          <Failure
            result={
              problem
                ? { ...failure, message: legacyCopy.forLocale(language).t(problemKey) }
                : presentation
                  ? { ...failure, message: presentation.message, messageCopy: undefined }
                  : failure
            }
          />
        </div>
      ) : success ? (
        <p className="more-success" role="status">
          <PresentedCopy value={success} />
        </p>
      ) : null}
      {known && !running ? (
        <div data-testid="failure" className="failure" role="alert">
          <p lang={copy.languageFor('cleanup')}>{copy.t('cleanup')}</p>
          <code lang="zxx" style={{ overflowWrap: 'anywhere' }}>
            {JSON.parse(known.raw).reference ?? JSON.parse(known.raw).id}
          </code>
          <Button variant="secondary" lang={copy.languageFor('retryCleanup')} onClick={() => void cleanup(known)}>
            {copy.t('retryCleanup')}
          </Button>
        </div>
      ) : saved.status === 'unreadable' && !running ? (
        <div data-testid="failure" className="failure" role="alert">
          <h3 lang={copy.languageFor('storageTitle')}>{copy.t('storageTitle')}</h3>
          <p lang={copy.languageFor('storageBody')}>{copy.t('storageBody')}</p>
          <Button variant="secondary" lang={copy.languageFor('retryStorage')} onClick={redraw}>
            {copy.t('retryStorage')}
          </Button>
        </div>
      ) : saved.status === 'present' && !running ? (
        <div data-testid="failure" className="failure" role="alert">
          {!action.result && (
            <h3>
              <Text k="common.outcome.not.confirmed" />
            </h3>
          )}
          <p>
            <Text k="common.earlier.request" />
            <span lang="und">{saved.value.title}</span>.{' '}
            {saved.value.reference && (
              <code lang="zxx" style={{ overflowWrap: 'anywhere' }}>
                {saved.value.reference}
              </code>
            )}
            <Text k="common.read.its.original.records.before.continuing" />
          </p>
          {saved.value.reference && canRecover ? (
            <Button variant="secondary" onClick={() => void recoverOriginal()}>
              <Text k="common.check.original.outcome" />
            </Button>
          ) : (
            <p>
              <Text k="common.this.action.has.no.universal.recovery.lookup" />
            </p>
          )}
        </div>
      ) : null}
    </>
  );
  const request = reviewing;
  const dialog = request ? (
    <Dialog title={<PresentedCopy value={request.title} />} onClose={() => dismiss(request)}>
      <PresentedCopy value={request.content} />
      <p className="muted">
        <Text k="common.acting.as.account" />
        <code lang="zxx">{userId}</code>
        <Text k="common.the.service.enforces.your.scope.and.jurisdiction" />
      </p>
      <div className="actions">
        <Button variant="secondary" onClick={() => dismiss(request)}>
          <Text k="common.back" />
        </Button>
        <Button onClick={() => void send(request)}>
          <PresentedCopy value={request.confirm} />
        </Button>
      </div>
    </Dialog>
  ) : null;
  const { view: _view, ...controls } = action;
  void _view;
  return { ...controls, feedback, dialog };
}

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Button } from '@intafaced/ui/lit';
import { BLOCKER_REFUSAL } from '@intafaced/contracts/protocol-blockers';
import type { useResource } from '../../../shared/resource';
import { ServiceOffNotice } from '../../../shared/service-off';
import { blockersFor, isServiceNotConnected, type Blocker, type ProtocolAction, type ProtocolSnapshot, type Source } from '../blockers';
import type { protocolCopy } from '../copy';
import { DataTable, EmptyState, Failure, Loading, Panel } from './parts';

/**
 * How the Web3 rooms show one service answer, their disabled actions with the blocker each waits on, and their fact rows,
 * drawn only from the Volt kit, and shared with ParkedProtocolRoom.
 */

type Translate = ReturnType<typeof protocolCopy.forLocale>['t'];
type Resource<T> = ReturnType<typeof useResource<T>>;

export function toSource<T>(value: Resource<T>): Source<T> {
  const { resource } = value;
  return resource.status === 'loading'
    ? { status: 'loading' }
    : resource.status === 'ready'
      ? { status: 'ok', data: resource.data }
      : { status: 'down', reason: resource.failure.reason, message: resource.failure.message, code: resource.failure.code };
}

/** The gateway's answer when the service did not reply: a crash, a restart or a service that is not running. */
const NO_ANSWER_CODE = 'edge.upstream_unavailable';
/**
 * The retry window: the room asks again on its own, and a person may ask again too. After this many no-answer replies in a
 * row, a second attempt is no longer worth offering, so the room says the service is not running here and hides Try again.
 */
const NO_ANSWER_ATTEMPTS = 3;
const NO_ANSWER_RETRY_MS = 4000;

/** The service did not reply. Inside the retry window it offers Try again; once the window has closed it says the service is not running here. */
export function NoAnswerNote({ service, closed, reload, t }: { service: string; closed: boolean; reload: () => void; t: Translate }) {
  return closed ? (
    <div data-testid="failure" className="lt-refusal" role="status">
      <h3 className="lt-refusal-title">{t('serviceNotRunning', { service })}</h3>
      <p className="lt-refusal-body">{t('serviceNotRunningBody')}</p>
    </div>
  ) : (
    <div data-testid="failure" className="lt-refusal" role="status">
      <h3 className="lt-refusal-title">{t('serviceNoAnswer', { service })}</h3>
      <p className="lt-refusal-body">{t('serviceNoAnswerBody')}</p>
      <Button tone="secondary" onClick={reload}>
        {t('tryAgain')}
      </Button>
    </div>
  );
}

/** True once the retry window has run out of attempts. Any other answer starts the count again. */
function useNoAnswerWindow<T>({ resource, reload }: Resource<T>): boolean {
  const [failures, setFailures] = useState(0);
  const latest = useRef(reload);
  latest.current = reload;
  const noAnswer = resource.status === 'failed' && resource.failure.code === NO_ANSWER_CODE;
  const counted = useRef<unknown>(null);
  useEffect(() => {
    if (resource.status === 'loading' || counted.current === resource) return;
    counted.current = resource;
    setFailures((count) => (noAnswer ? count + 1 : 0));
  }, [resource, noAnswer]);
  useEffect(() => {
    if (!noAnswer || failures === 0 || failures >= NO_ANSWER_ATTEMPTS) return;
    const timer = setTimeout(() => latest.current(), NO_ANSWER_RETRY_MS);
    return () => clearTimeout(timer);
  }, [noAnswer, failures]);
  return failures >= NO_ANSWER_ATTEMPTS;
}

/**
 * Render one service answer: spinner while it is in flight (the API client times out at 15s), a typed refuse when it fails.
 * With a `shell`, a failed answer keeps the table's column headers and says why the table is empty.
 * The gateway's "not connected" answer (edge.upstream_unwired) hides Try again, because a second attempt cannot change it.
 * A plain 502 (edge.upstream_unavailable) only says the service did not answer, which may be a crash or a restart, so it
 * is worded that way and keeps Try again; it is never dressed up as "not connected". If the retry window passes with no reply
 * (see NO_ANSWER_ATTEMPTS), the room says the service is not running here and Try again goes.
 */
export function Answer<T>({
  value,
  source,
  t,
  children,
  shell,
  service,
}: {
  value: Resource<T>;
  source: string;
  /** The service behind this answer, named in the "not connected" sentence. Defaults to Protocol. */
  service?: string;
  t: Translate;
  children: (data: T) => ReactNode;
  shell?: { label: string; headers: readonly ReactNode[] };
}) {
  const { resource, reload } = value;
  const windowClosed = useNoAnswerWindow(value);
  if (resource.status === 'loading') return <Loading label={t('checking', { source })} />;
  if (resource.status === 'failed') {
    const notConnected = isServiceNotConnected(resource.failure.code);
    const words = t('serviceNotConnected', { service: service ?? t('svc_protocol') });
    const noAnswer = !notConnected && resource.failure.code === NO_ANSWER_CODE;
    const reason = notConnected ? (
      <div data-testid="failure" className="lt-refusal" role="status">
        <p className="lt-refusal-body">{words}</p>
      </div>
    ) : noAnswer ? (
      <NoAnswerNote service={service ?? t('svc_protocol')} closed={windowClosed} reload={reload} t={t} />
    ) : (
      <Failure result={resource.failure} retry={reload} />
    );
    if (shell)
      return (
        <div data-source={source}>
          <DataTable label={shell.label} headers={shell.headers}>
            <tr>
              <td colSpan={shell.headers.length}>{notConnected ? <EmptyState title={words} /> : reason}</td>
            </tr>
          </DataTable>
        </div>
      );
    return (
      <div data-source={source}>
        <p className="lt-hint">{t('unreachableTitle', { source })}</p>
        {reason}
      </div>
    );
  }
  return <>{children(resource.data)}</>;
}

const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
export const flag = (t: Translate, value: boolean) => (value ? t('yes') : t('no'));
export const orNone = (t: Translate, value: string | number | null | undefined) =>
  value === null || value === undefined ? t('notReturned') : String(value);

export function Actions({ actions, snapshot, t }: { actions: readonly ProtocolAction[]; snapshot: ProtocolSnapshot; t: Translate }) {
  if (actions.length === 0) return null;
  return (
    <Panel title={t('actionsTitle')}>
      <p className="lt-hint">{t('actionsNote')}</p>
      <ul className="lt-actions">
        {actions.map((action) => {
          const found = blockersFor(action, snapshot);
          const first = found[0] as Blocker;
          // Two checks can wait on the same source and read the same sentence (venue and finality both need the indexer):
          // the list says each sentence once.
          const listed = [...new Map(found.map((entry) => [capital(t(entry.key, entry.params)), entry.code] as const)).entries()];
          const reason = t(first.key, first.params);
          // On its own (button title) the sentence starts a capital; after "Blocked:" it reads on from the colon.
          const standalone = capital(reason);
          const refusal = BLOCKER_REFUSAL[first.code];
          return (
            <li key={action} data-action={action}>
              <Button tone="secondary" disabled aria-disabled="true" title={standalone}>
                {t(`act_${action}`)}
              </Button>
              {refusal ? (
                // An outside dependency (the allowlist): the shell's one service-off sentence and code.
                <ServiceOffNotice code={refusal} action={t(`act_${action}`)} className="lt-hint" role="note" />
              ) : (
                // Our own gap or a plain state: its reason in the shared empty-state component, never an allowlist code.
                <div className="lt-hint" role="note">
                  <EmptyState title={t('blockedBy', { reason })} />
                </div>
              )}
              {listed.length > 1 && (
                <details>
                  <summary>{t('allBlockers')}</summary>
                  <ol>
                    {listed.map(([sentence, code]) => (
                      <li key={sentence} data-blocker={code}>
                        {sentence}
                      </li>
                    ))}
                  </ol>
                </details>
              )}
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}

/** Label and value rows, each value in the figures' face. */
export function Rows({ rows }: { rows: ReadonlyArray<readonly [string, ReactNode]>; t?: Translate }) {
  return (
    <dl className="lt-kv">
      {rows.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd className="lt-mono">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

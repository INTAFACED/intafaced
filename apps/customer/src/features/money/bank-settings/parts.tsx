import { useId, type ReactNode } from 'react';
import { Button, Switch } from '@intafaced/ui/lit';
import { Skeleton, type Refusal as RoomRefusal } from '@intafaced/ui/lit/templates';
import { isServiceNotConnected, type ApiResult } from '../../../shared/api';
import type { Resource } from '../../../shared/resource';
import { canTryAgain } from '../../../shared/try-again';
import { uiCopy, uiMessage } from '../../../shared/ui-copy';
import { refusalCopy } from '../../../data/refusals';
import { t as copyText } from '../copy';

/**
 * The bank's settings rooms' shared parts, drawn only from the Volt kit: the same words, roles and names as the older
 * money parts they stand in for (`DepthParts`, `components`' Section, ResourceView and Continuation, and `shared/ui`'s
 * Failure and Loading).
 */

type Failed = Extract<ApiResult<unknown>, { ok: false }>;
type UiT = ReturnType<typeof uiCopy.useCopy>['t'];

/** A service sometimes answers with its own refusal code as the message ("token.params_invalid"). */
const RAW_CODE = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/i;
/** A setting or code name inside a sentence; only underscored names count, so "v1.2" and "e.g." stay. */
const EMBEDDED_KEY = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)*\.[a-z][a-z0-9]*(?:_[a-z0-9]+)*\b/gi;
const embeddedKey = (message: string) => message.match(EMBEDDED_KEY)?.find((key) => key.includes('_'));

/** What a failed read says, in the same words `shared/ui`'s Failure uses. */
export interface FailureWords {
  title: string;
  body: string;
  bodyLang?: string;
  reference?: string;
  action?: { label: string; href: string };
  /** `alert` when the outcome is not confirmed, else `status`. */
  role: 'alert' | 'status';
  retry: boolean;
}

function failureWords(
  result: Failed,
  ui: { t: UiT; languageFor: (key: never) => string | undefined; requestedLocale: Parameters<typeof uiMessage>[1] },
): FailureWords {
  const { t } = ui;
  if (isServiceNotConnected(result.code)) return { title: t('not_mounted'), body: t('serviceNotConnected'), role: 'status', retry: false };
  const rawCode = RAW_CODE.test(result.message.trim()) ? result.message.trim() : result.code ? embeddedKey(result.message) : undefined;
  if (rawCode && !result.messageCopy) {
    const words = refusalCopy(result.code ?? rawCode);
    const uncertain = result.reason === 'uncertain';
    return {
      title: uncertain ? t('uncertain') : words.title,
      body: uncertain ? t('gatewayUncertain') : words.body,
      action: uncertain ? undefined : words.action,
      reference: words.reference,
      role: uncertain ? 'alert' : 'status',
      retry: canTryAgain(result),
    };
  }
  return {
    title: t(result.reason),
    body: result.messageCopy ? uiMessage(result.messageCopy, ui.requestedLocale) : result.message,
    bodyLang: result.messageCopy ? ui.languageFor(result.messageCopy.key as never) : undefined,
    action:
      result.reason === 'unauthorized'
        ? { label: t('signIn'), href: `/login?redirect=${encodeURIComponent(location.pathname + location.search)}` }
        : undefined,
    role: result.reason === 'uncertain' ? 'alert' : 'status',
    retry: result.reason !== 'unauthorized' && canTryAgain(result),
  };
}

const UNREACHABLE = new Set<string>(['unreachable', 'aborted', 'invalid_response', 'uncertain']);

/** A room's read that failed, as the template's refused state, in Failure's words. */
export function useRoomRefusal(): (result: Failed) => { refusal: RoomRefusal; retry: boolean } {
  const ui = uiCopy.useCopy();
  return (result) => {
    const words = failureWords(result, ui);
    return {
      refusal: {
        variant: UNREACHABLE.has(result.reason) ? 'unreachable' : 'refused',
        title: words.title,
        body: words.body,
        reference: words.reference ?? result.code,
        action: words.action,
      },
      retry: words.retry,
    };
  };
}

/** A part of a room whose read failed, in place: Failure's words, its test id and its Try again. */
export function Failure({ result, retry }: { result: Failed; retry?: () => void }) {
  const ui = uiCopy.useCopy();
  const words = failureWords(result, ui);
  return (
    <div className="lt-refusal" data-testid="failure" data-refusal="refused" role={words.role}>
      <h3 className="lt-refusal-title">{words.title}</h3>
      <p className="lt-refusal-body" lang={words.bodyLang}>
        {words.body}
      </p>
      {words.action ? (
        <a className="lt-link" href={words.action.href}>
          {words.action.label}
        </a>
      ) : null}
      {words.reference ? <p className="lt-ref">{words.reference}</p> : null}
      {retry && words.retry ? (
        <Button tone="secondary" onClick={retry}>
          {ui.t('retry')}
        </Button>
      ) : null}
    </div>
  );
}

/** A part of a room still reading: its final shape, and the words for a reader. */
export function Loading({ label }: { label?: ReactNode }) {
  const { t } = uiCopy.useCopy();
  return (
    <div role="status">
      <Skeleton shape="rows" count={3} />
      <span className="lt-sr">
        {label ?? t('loading')}
        {'…'}
      </span>
    </div>
  );
}

export function ResourceView<T>({
  resource,
  reload,
  children,
}: {
  resource: Resource<T>;
  reload: () => void;
  children: (data: T) => ReactNode;
}) {
  if (resource.status === 'loading') return <Loading />;
  if (resource.status === 'failed') return <Failure result={resource.failure} retry={reload} />;
  return <>{children(resource.data)}</>;
}

/** One of a room's sections: its heading (named as a region by it), a lead line, and its rows. */
export function Panel({
  title,
  lead,
  children,
  id,
  actions,
  level = 2,
}: {
  title: ReactNode;
  lead?: ReactNode;
  children: ReactNode;
  id?: string;
  actions?: ReactNode;
  /** A section inside another section is a level 3 heading. */
  level?: 2 | 3;
}) {
  const heading = useId();
  const Heading = level === 2 ? 'h2' : 'h3';
  return (
    <section aria-labelledby={heading} id={id}>
      <Heading id={heading}>{title}</Heading>
      {lead ? <p className="lt-hint">{lead}</p> : null}
      {actions ? <div className="lt-actions">{actions}</div> : null}
      {children}
    </section>
  );
}

/** A control that is on the screen but cannot be used, with the reason next to it in plain words. */
export function DisabledAction({
  label,
  reason,
  tone = 'secondary',
}: {
  label: ReactNode;
  reason: ReactNode;
  tone?: 'primary' | 'secondary' | 'quiet';
}) {
  const id = useId();
  return (
    <div>
      <Button tone={tone} disabled aria-describedby={id}>
        {label}
      </Button>
      <p id={id} className="lt-hint">
        {reason}
      </p>
    </div>
  );
}

/** Several controls that are blocked for one reason: the buttons sit side by side and the reason is said once. */
export function DisabledActions({
  labels,
  reason,
  tone = 'secondary',
}: {
  labels: ReactNode[];
  reason: ReactNode;
  tone?: 'primary' | 'secondary' | 'quiet';
}) {
  const id = useId();
  return (
    <div>
      <div className="lt-actions">
        {labels.map((label, index) => (
          <Button key={index} tone={tone} disabled aria-describedby={id}>
            {label}
          </Button>
        ))}
      </div>
      <p id={id} className="lt-hint">
        {reason}
      </p>
    </div>
  );
}

/** One label and its value in a list of facts (`<dl>`). */
export function Fact({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/** How many records a list read, what the limit means, and the way to read more where the service allows it. */
export function Continuation({ count, limit, onMore }: { count: number; limit: number; onMore: () => void }) {
  return (
    <div className="lt-toolbar">
      <span className="lt-hint">
        {count}
        {copyText('components.records.returned.requested.limit')}.{' '}
        {count >= limit
          ? limit < 200
            ? copyText('components.more.records.may.exist')
            : copyText('components.this.service.has.no.continuation.beyond.200')
          : copyText('components.this.list.has.no.total.count.or')}
      </span>
      {count >= limit && limit < 200 && (
        <Button tone="secondary" onClick={onMore}>
          {copyText('components.load.up.to')}
          {Math.min(200, limit + 50)}
        </Button>
      )}
    </div>
  );
}

/** One on-or-off setting: its name, its state in words beside it, and the kit's switch, named by the setting. */
export function ChannelSwitch({
  label,
  on,
  state,
  disabled,
  onToggle,
}: {
  label: string;
  on: boolean;
  state: ReactNode;
  disabled?: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="lt-toolbar">
      <span>{label}</span>
      <span className="lt-hint">{state}</span>
      <Switch checked={on} label={label} disabled={disabled} onChange={() => onToggle()} />
    </div>
  );
}

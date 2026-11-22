import type { ReactNode } from 'react';
import { Button } from '@intafaced/ui/lit';
import { KeyValue, ReadingTemplate, RefusalBox, Tabs } from '@intafaced/ui/lit/templates';
import { usePreferences } from '../../../shared/preferences';
import { useResource } from '../../../shared/resource';
import type { AuditStatus, createProtocolApi } from '../api';
import { SUBNAV, type Slug } from '../blockers';
import { protocolCopy } from '../copy';
import { NO_ANSWER_CODE, useNoAnswerWindow } from '../no-answer';
import { AuditProducts } from './AuditProducts';
import { canRetry, failureRefusal } from './failure';

type Resource<T> = ReturnType<typeof useResource<T>>;
type ProtocolApi = ReturnType<typeof createProtocolApi>;

/**
 * /chain/audit and /protocol/audit (D-developer-compliance-02), on the reading template: each product with the external
 * audit the owner recorded or "External audit: not done", and the internal package's audit state, which never says
 * audited. The room's sections stay one link each. The room reads the audit status its parent room already asked for.
 */
export function AuditRoom({
  slug,
  api,
  audit,
}: {
  slug: Extract<Slug, 'chain' | 'protocol'>;
  api: Pick<ProtocolApi, 'auditProducts'>;
  audit: Resource<AuditStatus>;
}) {
  const { language } = usePreferences();
  const { t, renderedLocale } = protocolCopy.forLocale(language);
  const tabs = SUBNAV[slug];
  return (
    <div lang={renderedLocale} data-route={slug}>
      <ReadingTemplate
        title={slug === 'chain' ? t('titleChain') : t('titleProtocol')}
        description={slug === 'chain' ? t('descChain') : t('descProtocol')}
        state={{ kind: 'ready' }}
        meta={
          <p className="lt-hint">
            {t('bannerLine')} <span className="lt-chip">{t('bannerPill')}</span>
          </p>
        }
        toc={
          <Tabs
            label={t('subnav')}
            current={`/${slug}/audit`}
            items={tabs.map((entry, i) => ({
              label: t(`tab_${entry.id}` as 'tab_status'),
              href: i === 0 ? `/${slug}` : `/${slug}/${entry.id}`,
            }))}
          />
        }
        body={<AuditProducts api={api} />}
        related={<AuditState audit={audit} />}
      />
    </div>
  );
}

/** The internal package's audit state: what it is and who signed it, and never a claim that it is audited. */
function AuditState({ audit }: { audit: Resource<AuditStatus> }) {
  const { language } = usePreferences();
  const { t } = protocolCopy.forLocale(language);
  return (
    <section aria-labelledby="audit-state-title">
      <h2 id="audit-state-title">{t('auditTitle')}</h2>
      <Answer value={audit} source={t('src_audit')}>
        {(a) => (
          <KeyValue
            label={t('auditTitle')}
            rows={[
              { label: t('auditedFlag'), value: t('auditedFalse') },
              { label: t('auditKind'), value: t('internalOnly') },
              { label: t('auditPackage'), value: a.id, ltr: true },
              { label: t('auditPath'), value: a.packagePath, ltr: true },
              { label: t('auditHash'), value: a.artifactHash, ltr: true },
              { label: t('auditSigned'), value: a.signedBy ?? t('unsigned') },
            ]}
          />
        )}
      </Answer>
    </section>
  );
}

/**
 * One service answer in the kit: "checking" while it is in flight, and a refusal when it fails. The gateway's "not
 * connected" answer hides Try again; a plain no-answer keeps it until the retry window closes, then says the service is
 * not running here (the parked room's rule, `NO_ANSWER_ATTEMPTS`).
 */
function Answer<T>({ value, source, children }: { value: Resource<T>; source: string; children: (data: T) => ReactNode }) {
  const { language } = usePreferences();
  const { t } = protocolCopy.forLocale(language);
  const { resource, reload } = value;
  const windowClosed = useNoAnswerWindow(value);
  if (resource.status === 'loading')
    return (
      <p className="lt-hint" role="status">
        {t('checking', { source })}…
      </p>
    );
  if (resource.status === 'ready') return <>{children(resource.data)}</>;
  const failure = resource.failure;
  const service = t('svc_protocol');
  const noAnswer = failure.code === NO_ANSWER_CODE;
  const refusal = noAnswer
    ? windowClosed
      ? { variant: 'unreachable' as const, title: t('serviceNotRunning', { service }), body: t('serviceNotRunningBody') }
      : { variant: 'unreachable' as const, title: t('serviceNoAnswer', { service }), body: t('serviceNoAnswerBody') }
    : failureRefusal(failure, language);
  const retry = noAnswer ? !windowClosed : canRetry(failure);
  return (
    <div data-source={source} data-testid="failure">
      <p className="lt-hint">{t('unreachableTitle', { source })}</p>
      <RefusalBox refusal={refusal} />
      {retry ? <Button onClick={reload}>{t('tryAgain')}</Button> : null}
    </div>
  );
}

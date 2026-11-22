import { Button } from '@intafaced/ui/lit';
import { FlowTemplate, KeyValue, RefusalBox, Skeleton, StatusChip } from '@intafaced/ui/lit/templates';
import type { ApiResult } from '../../../shared/api';
import { usePreferences } from '../../../shared/preferences';
import { useResource } from '../../../shared/resource';
import { uiCopy } from '../../../shared/ui-copy';
import { useApi } from '../../session';
import { copy as moreCopy } from '../copy';
import { academyLmsCopy as copy } from '../academy-lms-copy';
import { formatDay, parseVerifyCode } from '../academy-lms';
import { academyCodeOf, verifyCertificate, type VerifiedCertificate } from '../academy-flows';
import { academyFailureView } from '../academy-assignment/academy-failure';

/**
 * `/academy/certificates/verify/<code>`: the page a shared certificate link opens, signed in or not, on the flow
 * template. It shows exactly what Academy's public check answers for the code (valid or revoked, with the issue date)
 * or its typed refusal.
 */
export function CertificateVerifyRoom({ code }: { code: string | undefined }) {
  const { t } = copy.useCopy();
  const more = moreCopy.useCopy();
  const parsed = parseVerifyCode(code ?? '');
  return (
    <FlowTemplate
      title={more.t('moreroutes.academy')}
      description={more.t('moreroutes.learn.practise.and.join.hosted.sessions')}
      state={{ kind: 'ready' }}
      step={
        <div data-certificate-verify={parsed.kind === 'code' ? parsed.code : ''}>
          <h2>{t('verifyPageTitle')}</h2>
          <p className="lt-hint">{t('verifyPageIntro')}</p>
          {parsed.kind === 'code' ? (
            <VerifyAnswer code={parsed.code} />
          ) : (
            <p role="status">{(code ?? '').trim() ? t('verifyFormat') : t('verifyPageNoCode')}</p>
          )}
        </div>
      }
    />
  );
}

function VerifyAnswer({ code }: { code: string }) {
  const api = useApi();
  const { t } = copy.useCopy();
  const answer = useResource((signal) => verifyCertificate(api, code, signal), `certificate-verify:${code}`);
  if (answer.resource.status === 'loading')
    return (
      <>
        <p className="lt-sr" role="status">
          {t('verifyChecking')}
        </p>
        <Skeleton shape="rows" count={5} />
      </>
    );
  if (answer.resource.status === 'failed')
    return (
      <div data-code={academyCodeOf(answer.resource.failure) ?? undefined}>
        <VerifyFailure failure={answer.resource.failure} retry={answer.reload} />
      </div>
    );
  return <VerifyResult code={code} certificate={answer.resource.data} />;
}

/** Academy's typed refusal in its words, or the kit refusal with Try again where a second attempt can change it. */
function VerifyFailure({ failure, retry }: { failure: Extract<ApiResult<never>, { ok: false }>; retry: () => void }) {
  const { t } = copy.useCopy();
  const ui = uiCopy.useCopy();
  const here = typeof location === 'undefined' ? '' : location.pathname + location.search;
  const view = academyFailureView(failure, t, ui, here);
  if (view.kind === 'words')
    return (
      <div data-testid="failure" role="status">
        <p>{view.words}</p>
      </div>
    );
  return (
    <div data-testid="failure">
      <RefusalBox refusal={view.refusal} />
      {view.retry ? <Button onClick={retry}>{ui.t('retry')}</Button> : null}
    </div>
  );
}

/** What Academy says about one verification code. Every field is the service's answer. */
function VerifyResult({ code, certificate }: { code: string; certificate: VerifiedCertificate }) {
  const { t, Copy } = copy.useCopy();
  const { language } = usePreferences();
  const revoked = certificate.status === 'revoked';
  return (
    <section role="status" aria-label={t('verifyResultLabel')}>
      <KeyValue
        rows={[
          { label: t('verifyCertificate'), value: <span lang="und">{certificate.title}</span> },
          {
            label: t('verifyHolder'),
            value: certificate.holderName ? <span lang="und">{certificate.holderName}</span> : t('holderNotShared'),
          },
          { label: t('verifyIssued'), value: <span data-testid="verify-issued">{formatDay(certificate.grantedAt, language)}</span> },
          {
            label: t('verifyStatus'),
            value: (
              <span data-testid="verify-status" data-status={revoked ? 'revoked' : 'recorded'}>
                <StatusChip status={revoked ? 'failed' : 'done'} label={revoked ? t('verifyRevoked') : t('verifyValid')} />
              </span>
            ),
          },
          { label: t('sheetCode'), value: <code lang="zxx">{code}</code>, ltr: true },
        ]}
      />
      <p className={revoked ? undefined : 'lt-hint'}>
        <Copy k={revoked ? 'verifyRevokedNote' : 'verifyValidNote'} />
      </p>
    </section>
  );
}

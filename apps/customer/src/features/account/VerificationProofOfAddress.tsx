import { useState } from 'react';
import { kycPoaReadSchema, kycPoaSubmissionSchema, type KycPoaSubmission } from '@intafaced/contracts/identity-kyc-poa';
import type { ApiResult } from '../../shared/api';
import { useSession } from '../session/session';
import { useResource } from '../../shared/resource';
import { Button, Failure, Field, Loading } from '../../shared/ui';
import { verificationPoaCopy as copy } from './verification-poa-copy';

type Refusal = Extract<ApiResult<unknown>, { ok: false }>;
type Problem = { kind: 'copy'; text: string } | { kind: 'failure'; result: Refusal };
const kib = (bytes: number) => Math.ceil(bytes / 1024);
const statusKey = { submitted: 'statusSubmitted', accepted: 'statusAccepted', rejected: 'statusRejected' } as const;

function base64Of(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''));
    reader.readAsDataURL(file);
  });
}

/**
 * I-kyc-compliance-11 (J-identity-08 #5): proof of address on /verification, asked for once level Basic is approved.
 * It shows the owner's recency rule, and for the chosen country which documents count and which never do; a country
 * with no list says none is published. The file is checked against the owner's caps before it is sent and again by
 * the service. A document from another country than the residence is sent flagged, and the page says the reviewer
 * checks it. `recordsKey` is the page's status read, so an approval reads this again.
 */
export function VerificationProofOfAddress({ recordsKey }: { recordsKey: string }) {
  const { api, userId } = useSession();
  const { t, Copy } = copy.useCopy();
  const [country, setCountry] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const chosen = country && /^[A-Z]{2}$/.test(country) ? country : undefined;
  const { resource, reload } = useResource(
    (signal) => api.query('identity', 'kyc.proofOfAddress.read', chosen ? { country: chosen } : {}, kycPoaReadSchema, { signal }),
    `verification-poa:${userId}:${recordsKey}:${chosen ?? ''}:${revision}`,
  );
  const [type, setType] = useState('');
  const [issuedOn, setIssuedOn] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [sent, setSent] = useState<KycPoaSubmission | null>(null);

  const body = () => {
    if (resource.status === 'loading') return <Loading />;
    if (resource.status === 'failed')
      return (
        <>
          <h3>
            <Copy k="failedTitle" />
          </h3>
          <Failure result={resource.failure} retry={reload} />
        </>
      );
    const { requested, residence, maxAgeDays, documents, latest, uploadCaps } = resource.data;
    if (!requested)
      return (
        <p className="muted" data-testid="verification__poa-state" data-state="not-requested">
          <Copy k="notRequested" />
        </p>
      );
    const shownCountry = country ?? residence ?? '';
    const refused = (result: Refusal) => {
      switch (result.code) {
        case 'kyc.poa_too_old':
          return setProblem({ kind: 'copy', text: t('tooOld', { days: String(maxAgeDays ?? '') }) });
        case 'kyc.poa_type_refused':
          return setProblem({ kind: 'copy', text: t('typeRefused') });
        case 'kyc.poa_date_invalid':
          return setProblem({ kind: 'copy', text: t('dateInvalid') });
        case 'kyc.poa_types_unset':
        case 'kyc.poa_type_unlisted':
          return setProblem({ kind: 'copy', text: t('unpublished', { country: shownCountry }) });
        case 'kyc.poa_rule_unset':
          return setProblem({ kind: 'copy', text: t('ruleUnset') });
        case 'kyc.upload_caps_unset':
          return setProblem({ kind: 'copy', text: t('capsUnset') });
        case 'kyc.upload_too_large':
          return setProblem({ kind: 'copy', text: uploadCaps ? t('overCap', { kib: String(kib(uploadCaps.maxBytes)) }) : t('capsUnset') });
        case 'kyc.upload_type':
          return setProblem({
            kind: 'copy',
            text: uploadCaps ? t('wrongType', { types: uploadCaps.contentTypes.join(', ') }) : t('capsUnset'),
          });
        default:
          return setProblem({ kind: 'failure', result });
      }
    };
    const send = async () => {
      if (!file || !uploadCaps) return;
      if (file.size > uploadCaps.maxBytes)
        return setProblem({ kind: 'copy', text: t('tooLarge', { size: String(kib(file.size)), kib: String(kib(uploadCaps.maxBytes)) }) });
      if (!uploadCaps.contentTypes.includes(file.type))
        return setProblem({ kind: 'copy', text: t('wrongType', { types: uploadCaps.contentTypes.join(', ') }) });
      setBusy(true);
      setProblem(null);
      setSent(null);
      try {
        let bytesBase64: string;
        try {
          bytesBase64 = await base64Of(file);
        } catch {
          return setProblem({ kind: 'copy', text: t('unreadable') });
        }
        const answer = await api.mutate(
          'identity',
          'kyc.proofOfAddress.submit',
          { type, country: shownCountry, issuedOn, contentType: file.type, bytesBase64 },
          kycPoaSubmissionSchema,
        );
        if (!answer.ok) return refused(answer);
        setSent(answer.data);
        setRevision((n) => n + 1);
      } finally {
        setBusy(false);
      }
    };
    return (
      <div className="stack">
        <p data-testid="verification__poa-rule" data-max-age-days={maxAgeDays ?? ''}>
          {maxAgeDays ? <Copy k="rule" params={{ days: String(maxAgeDays) }} /> : <Copy k="ruleUnset" />}
        </p>
        {residence && (
          <p className="muted">
            <Copy k="residence" params={{ country: residence }} />
          </p>
        )}
        {latest && (
          <p data-testid="verification__poa-latest" data-status={latest.status} data-mismatch={latest.countryMismatch}>
            <Copy
              k="latest"
              params={{
                type: [...documents.accepted, ...documents.rejected].find((row) => row.type === latest.type)?.label ?? latest.type,
                country: latest.country,
                issuedOn: latest.issuedOn,
                status: t(statusKey[latest.status]),
              }}
            />
          </p>
        )}
        <form
          className="form-stack"
          onSubmit={(event) => {
            event.preventDefault();
            void send();
          }}
        >
          <Field
            label={t('countryField')}
            name="poa-country"
            required
            maxLength={2}
            pattern="[a-zA-Z]{2}"
            value={shownCountry}
            disabled={busy}
            hint={t('countryHint')}
            onChange={(event) => {
              setType('');
              setCountry(event.target.value.trim().toUpperCase());
            }}
          />
          <div data-testid="verification__poa-documents" data-published={documents.published} data-country={documents.country ?? ''}>
            {!documents.published ? (
              <p>
                <Copy k="unpublished" params={{ country: shownCountry || '—' }} />
              </p>
            ) : (
              <>
                <h3>
                  <Copy k="accepted" />
                </h3>
                <ul data-testid="verification__poa-accepted">
                  {documents.accepted.map((row) => (
                    <li key={row.type}>{row.label}</li>
                  ))}
                </ul>
                {documents.rejected.length > 0 && (
                  <>
                    <h3>
                      <Copy k="refused" />
                    </h3>
                    <ul data-testid="verification__poa-refused">
                      {documents.rejected.map((row) => (
                        <li key={row.type}>{row.label}</li>
                      ))}
                    </ul>
                  </>
                )}
              </>
            )}
          </div>
          {documents.published && (
            <label className="field">
              <span>
                <Copy k="typeField" />
              </span>
              <select required value={type} disabled={busy} onChange={(event) => setType(event.target.value)}>
                <option value="" disabled />
                {documents.accepted.map((row) => (
                  <option key={row.type} value={row.type}>
                    {row.label}
                  </option>
                ))}
              </select>
            </label>
          )}
          <Field
            label={t('issuedOnField')}
            name="poa-issued-on"
            type="date"
            required
            value={issuedOn}
            disabled={busy}
            hint={t('issuedOnHint')}
            onChange={(event) => setIssuedOn(event.target.value)}
          />
          {uploadCaps ? (
            <Field
              label={t('fileField')}
              name="poa-file"
              type="file"
              accept={uploadCaps.contentTypes.join(',')}
              required
              disabled={busy}
              hint={t('fileHint', { types: uploadCaps.contentTypes.join(', '), kib: String(kib(uploadCaps.maxBytes)) })}
              onChange={(event) => {
                setProblem(null);
                setFile(event.target.files?.[0] ?? null);
              }}
            />
          ) : (
            <p>
              <Copy k="capsUnset" />
            </p>
          )}
          <Button type="submit" disabled={busy || !file || !uploadCaps || !maxAgeDays || !documents.published || !type}>
            <Copy k={busy ? 'sending' : 'send'} />
          </Button>
        </form>
        {sent && (
          <div role="status" data-testid="verification__poa-sent">
            <p>
              <Copy k="sent" />
            </p>
            {sent.countryMismatch && residence && (
              <p data-testid="verification__poa-mismatch">
                <Copy k="mismatch" params={{ country: sent.country, residence }} />
              </p>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <section className="verification__cases" aria-labelledby="verification-poa-title" data-testid="verification__poa">
      <h2 id="verification-poa-title">
        <Copy k="title" />
      </h2>
      <p className="muted">
        <Copy k="intro" />
      </p>
      {body()}
      {problem && (
        <div role="alert" data-testid="verification__poa-problem">
          {problem.kind === 'copy' ? <p>{problem.text}</p> : <Failure result={problem.result} />}
        </div>
      )}
    </section>
  );
}

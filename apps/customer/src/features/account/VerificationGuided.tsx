import { useState, type FormEvent } from 'react';
import {
  KYC_PROFILE_STEPS,
  kycDocumentTypesSchema,
  kycProfileDraftSchema,
  kycProfileSchema,
  type KycProfileDraft,
  type KycProfileFieldStep,
  type KycProfileFields,
  type KycProfileStep,
  type KycProfileUploadCaps,
} from '@intafaced/contracts/identity-kyc-profile';
import { z } from 'zod';
import type { ApiResult } from '../../shared/api';
import { base64Of, kib } from '../../shared/file-base64';
import { useSession } from '../session/session';
import { useResource } from '../../shared/resource';
import { Button, Failure, Field, Loading } from '../../shared/ui';
import { verificationGuidedCopy as copy } from './verification-guided-copy';

type Tier = KycProfileDraft['tier'];
type Refusal = Extract<ApiResult<unknown>, { ok: false }>;
type Problem = { kind: 'copy'; text: string } | { kind: 'failure'; result: Refusal };
const sentSchema = z.object({ recordId: z.string().uuid(), documentCheck: z.literal('not_connected') });

/**
 * I-kyc-compliance-08 (J-identity-08 #2): guided verification on /verification. Six steps with progress; each save
 * keeps the draft on the service, so a person who leaves comes back at the step they left with what they entered. The
 * ID step lists the owner's accepted IDs for the country, or says none is published. The photo is checked against the
 * owner's caps before it is sent and again by the service. With the automatic document check not connected, the page
 * says a person reviews the documents. `tier` is the level the request form has chosen; `onSent` reads the page again.
 */
export function VerificationGuided({ tier, disabled, onSent }: { tier: Tier; disabled: boolean; onSent: () => void }) {
  const { api, userId } = useSession();
  const { t, Copy } = copy.useCopy();
  const { resource, reload } = useResource(
    (signal) => api.query('identity', 'kyc.profile.read', undefined, kycProfileSchema, { signal }),
    `verification-guided:${userId}`,
  );
  const [view, setView] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [sent, setSent] = useState(false);

  function refused(result: Refusal, caps: KycProfileUploadCaps | null) {
    switch (result.code) {
      case 'kyc.profile_version':
      case 'kyc.profile_sent':
      case 'kyc.profile_none':
        setProblem({ kind: 'copy', text: t('changed') });
        return reload();
      case 'kyc.upload_too_large':
        return setProblem({ kind: 'copy', text: caps ? t('overCap', { kib: String(kib(caps.maxBytes)) }) : t('capsUnset') });
      case 'kyc.upload_type':
        return setProblem({ kind: 'copy', text: caps ? t('wrongType', { types: caps.contentTypes.join(', ') }) : t('capsUnset') });
      case 'kyc.upload_caps_unset':
        return setProblem({ kind: 'copy', text: t('capsUnset') });
      case 'kyc.profile_request_open':
        return setProblem({ kind: 'copy', text: t('requestOpen') });
      case 'kyc.document_types_unset':
        return setProblem({ kind: 'copy', text: t('typesUnset') });
      case 'kyc.document_type_unlisted':
        return setProblem({ kind: 'copy', text: t('typeUnlisted') });
      case 'kyc.profile_incomplete':
        return setProblem({ kind: 'copy', text: t('incomplete') });
      case 'kyc.profile_invalid':
        return setProblem({ kind: 'copy', text: t('invalid') });
      default:
        return setProblem({ kind: 'failure', result });
    }
  }

  /** One call to the service; on success the page reads the draft again, and `done` runs with the answer. */
  async function run<T>(call: () => Promise<ApiResult<T>>, caps: KycProfileUploadCaps | null, done?: () => void) {
    setBusy(true);
    setProblem(null);
    try {
      let answer: ApiResult<T>;
      try {
        answer = await call();
      } catch {
        // Only reading the chosen file throws here; the API answers every refusal as a result.
        return setProblem({ kind: 'copy', text: t('unreadable') });
      }
      if (!answer.ok) return refused(answer, caps);
      setView(null);
      reload();
      done?.();
    } finally {
      setBusy(false);
    }
  }

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
    const { draft, unreadableDraft, uploadCaps, documentCheck } = resource.data;
    const open = draft && !draft.recordId ? draft : null;
    if (!open)
      return (
        <div className="stack">
          {draft?.recordId && sent && (
            <p role="status" data-testid="verification__guided-sent">
              <Copy k="sent" />
            </p>
          )}
          {unreadableDraft && (
            <p data-testid="verification__guided-unreadable">
              <Copy k="draftUnreadable" />
            </p>
          )}
          {documentCheck === 'not_connected' && (
            <p className="muted" data-testid="verification__guided-manual">
              <Copy k="manualReview" />
            </p>
          )}
          <p className="muted">
            <Copy k="startLevel" params={{ level: t(tier) }} />
          </p>
          <Button
            disabled={disabled || busy}
            onClick={() => {
              setSent(false);
              void run(() => api.mutate('identity', 'kyc.profile.start', { tier }, kycProfileDraftSchema), uploadCaps);
            }}
          >
            <Copy k={draft?.recordId ? 'again' : 'start'} />
          </Button>
        </div>
      );
    const shown = Math.min(view ?? open.step, open.step);
    const name = (n: number) => t(KYC_PROFILE_STEPS[n - 1]!);
    return (
      <div className="stack">
        <p className="muted" data-testid="verification__guided-level" data-level={open.tier}>
          <Copy k="startLevel" params={{ level: t(open.tier) }} />
          {open.tier !== tier && (
            <>
              {' '}
              <button
                type="button"
                className="text-link"
                disabled={busy || disabled}
                onClick={() => void run(() => api.mutate('identity', 'kyc.profile.start', { tier }, kycProfileDraftSchema), uploadCaps)}
              >
                <Copy k="switchLevel" params={{ level: t(tier) }} />
              </button>
            </>
          )}
        </p>
        {open.step > 1 && (
          <p data-testid="verification__guided-resume" data-step={open.step}>
            <Copy k="resume" params={{ step: String(open.step), name: name(open.step) }} />
          </p>
        )}
        <ol className="verification__guided-steps" data-testid="verification__guided-steps" aria-label={t('stepsLabel')}>
          {KYC_PROFILE_STEPS.map((step, i) => (
            <li key={step} data-step={step} aria-current={i + 1 === shown ? 'step' : undefined}>
              {i + 1 <= open.step ? (
                <button type="button" className="text-link" disabled={busy} onClick={() => setView(i + 1)}>
                  {i + 1}. <Copy k={step} />
                </button>
              ) : (
                <span className="muted">
                  {i + 1}. <Copy k={step} />
                </span>
              )}
            </li>
          ))}
        </ol>
        <h3>
          <Copy k="stepOf" params={{ step: String(shown) }} /> · {name(shown)}
        </h3>
        <GuidedStep
          key={`${open.version}:${shown}`}
          step={KYC_PROFILE_STEPS[shown - 1]!}
          draft={open}
          caps={uploadCaps}
          busy={busy || disabled}
          onProblem={setProblem}
          onSave={(step, fields) =>
            void run(
              () => api.mutate('identity', 'kyc.profile.saveStep', { step, version: open.version, fields }, kycProfileDraftSchema),
              uploadCaps,
            )
          }
          onUpload={(file) =>
            void run(
              async () =>
                api.mutate(
                  'identity',
                  'kyc.profile.upload',
                  { version: open.version, contentType: file.type, bytesBase64: await base64Of(file) },
                  kycProfileDraftSchema,
                ),
              uploadCaps,
            )
          }
          onSend={() =>
            void run(
              () => api.mutate('identity', 'kyc.profile.submit', { version: open.version }, sentSchema),
              uploadCaps,
              () => {
                setSent(true);
                onSent();
              },
            )
          }
        />
      </div>
    );
  };

  return (
    <section className="verification__cases" aria-labelledby="verification-guided-title" data-testid="verification__guided">
      <h2 id="verification-guided-title">
        <Copy k="title" />
      </h2>
      <p className="muted">
        <Copy k="intro" />
      </p>
      {body()}
      {problem && (
        <div role="alert" data-testid="verification__guided-problem">
          {problem.kind === 'copy' ? <p>{problem.text}</p> : <Failure result={problem.result} />}
        </div>
      )}
    </section>
  );
}

function GuidedStep({
  step,
  draft,
  caps,
  busy,
  onProblem,
  onSave,
  onUpload,
  onSend,
}: {
  step: KycProfileStep;
  draft: KycProfileDraft;
  caps: KycProfileUploadCaps | null;
  busy: boolean;
  onProblem: (problem: Problem | null) => void;
  onSave: (step: KycProfileFieldStep, fields: Record<string, unknown>) => void;
  onUpload: (file: File) => void;
  onSend: () => void;
}) {
  const { api } = useSession();
  const { t, Copy } = copy.useCopy();
  const f = draft.fields;
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(Object.entries(f).map(([k, v]) => [k, typeof v === 'string' ? v : ''])),
  );
  const [file, setFile] = useState<File | null>(null);
  const country = (f.residence ?? '').toUpperCase();
  const types = useResource(
    (signal) =>
      (step === 'document' || step === 'review') && country
        ? api.query('identity', 'kyc.documentTypes.read', { country }, kycDocumentTypesSchema, { signal })
        : Promise.resolve({ ok: true as const, data: { country: country || 'XX', published: false, types: [] } }),
    `verification-guided-types:${step}:${country}`,
  ).resource;
  const field = (key: keyof KycProfileFields, label: string, extra: Partial<Parameters<typeof Field>[0]> = {}) => (
    <Field
      label={label}
      name={`kyc-${key}`}
      value={values[key] ?? ''}
      disabled={busy}
      onChange={(event) => setValues((v) => ({ ...v, [key]: event.target.value }))}
      {...extra}
    />
  );
  const trimmed = (key: string) => (values[key] ?? '').trim();
  const optional = (key: string) => trimmed(key) || null;
  const submit = (event: FormEvent, fields: Record<string, unknown>) => {
    event.preventDefault();
    onSave(step as KycProfileFieldStep, fields);
  };
  const saveButton = (
    <Button type="submit" disabled={busy}>
      <Copy k={busy ? 'saving' : 'save'} />
    </Button>
  );

  if (step === 'residence')
    return (
      <form
        className="form-stack"
        onSubmit={(e) => submit(e, { residence: trimmed('residence').toUpperCase(), nationality: trimmed('nationality').toUpperCase() })}
      >
        {field('residence', t('residenceField'), { required: true, maxLength: 2, pattern: '[a-zA-Z]{2}', hint: t('countryHint') })}
        {field('nationality', t('nationalityField'), { required: true, maxLength: 2, pattern: '[a-zA-Z]{2}', hint: t('countryHint') })}
        {saveButton}
      </form>
    );
  if (step === 'identity')
    return (
      <form
        className="form-stack"
        onSubmit={(e) =>
          submit(e, { legalName: trimmed('legalName'), localName: optional('localName'), dateOfBirth: trimmed('dateOfBirth') })
        }
      >
        {field('legalName', t('legalNameField'), { required: true, maxLength: 200, hint: t('legalNameHint') })}
        {field('localName', t('localNameField'), { maxLength: 200 })}
        {field('dateOfBirth', t('dateOfBirthField'), { required: true, type: 'date' })}
        {saveButton}
      </form>
    );
  if (step === 'document') {
    if (types.status === 'loading') return <Loading label={<Copy k="typesLoading" />} />;
    if (types.status === 'failed') return <Failure result={types.failure} />;
    if (!types.data.published)
      return (
        <p data-testid="verification__guided-doc-types" data-published="false">
          <Copy k="typesUnpublished" params={{ country: country || '—' }} />
        </p>
      );
    const chosen = types.data.types.find((row) => row.type === values.documentType) ?? null;
    return (
      <form
        className="form-stack"
        data-testid="verification__guided-doc-types"
        data-published="true"
        onSubmit={(e) => submit(e, { documentType: trimmed('documentType'), documentNumber: trimmed('documentNumber') })}
      >
        <label className="field">
          <span>
            <Copy k="documentTypeField" />
          </span>
          <select
            required
            value={values.documentType ?? ''}
            disabled={busy}
            onChange={(event) => setValues((v) => ({ ...v, documentType: event.target.value }))}
          >
            <option value="" disabled />
            {types.data.types.map((row) => (
              <option key={row.type} value={row.type}>
                {row.label}
              </option>
            ))}
          </select>
        </label>
        {chosen?.originalRequired && (
          <p className="muted">
            <Copy k="originalRequired" />
          </p>
        )}
        {field('documentNumber', t('documentNumberField'), { required: true, maxLength: 64 })}
        {saveButton}
      </form>
    );
  }
  if (step === 'address')
    return (
      <form
        className="form-stack"
        onSubmit={(e) => submit(e, { addressLine: trimmed('addressLine'), city: trimmed('city'), postalCode: trimmed('postalCode') })}
      >
        {field('addressLine', t('addressLineField'), { required: true, maxLength: 200 })}
        {field('city', t('cityField'), { required: true, maxLength: 100 })}
        {field('postalCode', t('postalCodeField'), { required: true, maxLength: 20 })}
        {saveButton}
      </form>
    );
  if (step === 'upload') {
    if (!caps)
      return (
        <p data-testid="verification__guided-caps" data-caps="unset">
          <Copy k="capsUnset" />
        </p>
      );
    return (
      <form
        className="form-stack"
        onSubmit={(event) => {
          event.preventDefault();
          if (!file) return;
          // The owner's caps, before anything is sent; the service checks them again.
          const tooLarge =
            kib(file.size) === kib(caps.maxBytes)
              ? t('tooLargeBytes', { size: String(file.size), max: String(caps.maxBytes) })
              : t('tooLarge', { size: String(kib(file.size)), kib: String(kib(caps.maxBytes)) });
          if (file.size === 0) return onProblem({ kind: 'copy', text: t('emptyFile') });
          if (file.size > caps.maxBytes) return onProblem({ kind: 'copy', text: tooLarge });
          if (!caps.contentTypes.includes(file.type.toLowerCase()))
            return onProblem({ kind: 'copy', text: t('wrongType', { types: caps.contentTypes.join(', ') }) });
          onUpload(file);
        }}
      >
        {f.documentId && (
          <p className="muted">
            <Copy k="fileStored" />
          </p>
        )}
        <Field
          label={t('fileField')}
          name="kyc-document-file"
          type="file"
          accept={caps.contentTypes.join(',')}
          required
          disabled={busy}
          hint={t('fileHint', { types: caps.contentTypes.join(', '), kib: String(kib(caps.maxBytes)) })}
          data-testid="verification__guided-caps"
          data-max-bytes={caps.maxBytes}
          onChange={(event) => {
            onProblem(null);
            setFile(event.target.files?.[0] ?? null);
          }}
        />
        <Button type="submit" disabled={busy || !file}>
          <Copy k="uploadButton" />
        </Button>
      </form>
    );
  }
  const rows: Array<[string, string | null]> = [
    [t('residenceField'), f.residence],
    [t('nationalityField'), f.nationality],
    [t('legalNameField'), f.legalName],
    [t('localNameField'), f.localName],
    [t('dateOfBirthField'), f.dateOfBirth],
    // The owner's label for the country, as chosen in step 3; the code itself only if the list cannot be read.
    [
      t('documentTypeField'),
      (types.status === 'ready' && types.data.types.find((row) => row.type === f.documentType)?.label) || f.documentType,
    ],
    [t('documentNumberField'), f.documentNumber],
    [t('addressLineField'), f.addressLine],
    [t('cityField'), f.city],
    [t('postalCodeField'), f.postalCode],
  ];
  return (
    <div className="stack" data-testid="verification__guided-review">
      <dl>
        {rows.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value ?? <Copy k="notEntered" />}</dd>
          </div>
        ))}
      </dl>
      <p className="muted">{f.documentId ? <Copy k="fileStored" /> : <Copy k="notEntered" />}</p>
      <Button disabled={busy} onClick={onSend}>
        <Copy k="send" />
      </Button>
    </div>
  );
}

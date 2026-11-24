import { useEffect, useRef, useState } from 'react';
import type { ApiResult } from '../../shared/api';
import { useResource } from '../../shared/resource';
import { Button, Field } from '@intafaced/ui/lit';
import { KitRead, Section, Waiting } from './volt-parts';
import { KitDetails } from './volt-action';
import { usePreferences } from '../../shared/preferences';
import { useApi, useSession } from '../session';
import { academyLmsCopy as copy } from './academy-lms-copy';
import {
  academyVerifyHref,
  certificateXp,
  certificateCards,
  certificateDocument,
  certificateLessons,
  formatDay,
  formatMoment,
  issueWait,
  lessonHrefFor,
  parseVerifyCode,
  type CertGrant,
  type CertPathRow,
  type CertificateCard,
  type LessonSummary,
  type Tracking,
} from './academy-lms';
import { academyCodeOf, verifyCertificate, type VerifiedCertificate } from './academy-flows';
import { useAcademyTracking } from './academy-tracking';
import { ProgrammeCertificates } from './AcademyCourseProgrammes';
import { CertificateChip, GuardedButton, LessonStatusChip, ProgressMeter } from './academy-kit-parts';
import { AcademyRefusal } from './academy-refusal';
import { pathLabel } from './academy-labels';
import { ACADEMY_CERT_XP_PLANE } from '@intafaced/contracts/academy-cert-xp-plane-procedures';
import { ACADEMY_CERT_PATHS } from '@intafaced/contracts/academy-cert-paths-procedures';

const param = (name: string) => (typeof window === 'undefined' ? '' : (new URLSearchParams(window.location.search).get(name) ?? ''));

/** Certificates tab: every published certificate with its real state, the printable document, and the verify box. */
export function CertificateShelf() {
  const overview = useAcademyTracking();
  const [reference, setReference] = useState(param('verify'));
  // The verify box needs only the code, so a failed or empty tracking read never hides it.
  return (
    <div className="lt-stack">
      <KitRead resource={overview.resource} retry={overview.reload}>
        {(data) => (
          <Shelf
            lessons={data.lessons}
            tracking={data.tracking}
            onCheckCode={(code) => {
              setReference(code);
              document.getElementById(VERIFY_FIELD)?.focus();
            }}
          />
        )}
      </KitRead>
      <VerifyPanel reference={reference} onReference={setReference} />
    </div>
  );
}

function Shelf({
  lessons,
  tracking,
  onCheckCode,
}: {
  lessons: readonly LessonSummary[];
  tracking: Tracking;
  onCheckCode: (code: string) => void;
}) {
  const { t, Copy } = copy.useCopy();
  const cards = certificateCards(tracking);
  const earned = cards.filter((c) => c.state === 'earned');
  const [viewId, setViewId] = useState(param('view') || earned[0]?.definition.id || '');
  const view = cards.find((c) => c.definition.id === viewId);
  return (
    <div className="lt-stack">
      <Section title={t('shelfTitle')}>
        <section className="lt-stack" data-certificates="courses" aria-labelledby="academy-course-certificates">
          <h3 id="academy-course-certificates">{t('coursesTitle')}</h3>
          <p role="status">
            {cards.length === 0 ? (
              <Copy k="shelfEmpty" />
            ) : (
              <Copy k="shelfSummary" params={{ earned: earned.length, total: cards.length }} />
            )}
          </p>
          <div className="lt-stack">
            {cards.map((card) => (
              <CertificateCardView key={card.definition.id} card={card} lessons={lessons} onView={() => setViewId(card.definition.id)} />
            ))}
            <UnpublishedPaths />
          </div>
        </section>
        <section className="lt-stack" data-certificates="programmes" aria-labelledby="academy-programme-certificates">
          <h3 id="academy-programme-certificates">{t('programmeCertsTitle')}</h3>
          <ProgrammeCertificates />
        </section>
      </Section>
      {view && <CertificateSheet card={view} lessons={lessons} onCheckCode={onCheckCode} />}
    </div>
  );
}

/**
 * Every learning path with no published certificate design, as Academy lists it with its typed refusal. A failed read
 * shows the refusal it got, never "unpublished".
 */
function UnpublishedPaths() {
  const api = useApi();
  const answer = useResource((signal) => api.call(ACADEMY_CERT_PATHS, undefined, { signal }), 'cert-paths');
  if (answer.resource.status === 'loading') return <Waiting />;
  if (answer.resource.status === 'failed') return <AcademyRefusal failure={answer.resource.failure} retry={answer.reload} />;
  return (
    <>
      {answer.resource.data
        .filter((row) => row.refusal !== null)
        .map((row) => (
          <UnpublishedPathCard key={row.path} row={row} />
        ))}
    </>
  );
}

function UnpublishedPathCard({ row }: { row: CertPathRow }) {
  const { t } = copy.useCopy();
  return (
    <article className="lt-stack" data-certificate-path={row.path} data-state="unpublished">
      <h4>{pathLabel(t, row.path)}</h4>
      <div data-testid="academy-lms-meta" className="lt-actions lt-hint">
        <span className="lt-chip" data-status="unpublished">
          <span className="lt-chip-mark" aria-hidden="true" />
          {t('stateUnpublished')}
        </span>
      </div>
      <p data-code={row.refusal ?? undefined}>{t('pathUnpublished')}</p>
    </article>
  );
}

function CertificateCardView({ card, lessons, onView }: { card: CertificateCard; lessons: readonly LessonSummary[]; onView: () => void }) {
  const { t, Copy } = copy.useCopy();
  const { language } = usePreferences();
  const required = card.progress?.requiredCount ?? card.definition.requiredItemSlugs.length;
  const missing = card.progress?.missingItemSlugs[0];
  const missingLesson = lessons.find((l) => l.slug === missing);
  return (
    <article className="lt-stack" data-certificate={card.definition.id} data-state={card.state}>
      <h4 lang="und">{card.definition.title}</h4>
      <div data-testid="academy-lms-meta" className="lt-actions lt-hint">
        <CertificateChip state={card.state} />
      </div>
      <ProgressMeter percent={card.percent} label={t('certProgressLabel', { title: card.definition.title })} />
      <p>
        <Copy k="requiredRecorded" params={{ completed: card.progress?.completedCount ?? 0, required }} />
      </p>
      {card.grant && (
        <p className="lt-muted">
          <Copy k="issuedOn" params={{ date: formatDay(card.grant.grantedAt, language) }} />
        </p>
      )}
      {!card.grant && <IssueLine progress={card.progress} />}
      {card.state === 'revoked' && <p data-testid="certificate-revoked">{t('revokedNote')}</p>}
      <div className="lt-actions">
        {card.state === 'earned' && (
          <Button tone="secondary" onClick={onView}>
            <Copy k="viewCertificate" />
          </Button>
        )}
        {card.state !== 'earned' && missing && (
          <a className="lt-link lt-link-alone" href={lessonHrefFor(missing, card.definition.id, missingLesson?.path)}>
            <Copy k="continueLearning" />
          </a>
        )}
        {card.state === 'ready' && (
          <p className="lt-muted">
            <Copy k="readyHint" />
          </p>
        )}
      </div>
    </article>
  );
}

/** How a certificate not yet held is issued: after the owner's wait (with the time), or the moment the course is complete. */
function IssueLine({ progress }: { progress: CertificateCard['progress'] }) {
  const { t } = copy.useCopy();
  const { language } = usePreferences();
  const issue = progress?.issue;
  if (!issue || progress.granted) return null;
  if (issue.mode === 'delayed' && issue.delayMinutes !== null) {
    const wait = issueWait(issue.delayMinutes);
    const words = t(wait.unit, { n: wait.n });
    return (
      <p data-testid="certificate-issue">
        {issue.issuesAt
          ? t('issueDelayed', { date: formatMoment(issue.issuesAt, language), wait: words })
          : t('issueAfterWait', { wait: words })}
      </p>
    );
  }
  if (issue.mode === 'automatic') {
    return (
      <p className="lt-muted" data-testid="certificate-issue">
        {t('issueAutomatic')}
      </p>
    );
  }
  return null;
}

function CertificateSheet({
  card,
  lessons,
  onCheckCode,
}: {
  card: CertificateCard;
  lessons: readonly LessonSummary[];
  onCheckCode: (code: string) => void;
}) {
  const { t, Copy } = copy.useCopy();
  const { userId } = useSession();
  const { language } = usePreferences();
  const doc = userId ? certificateDocument(card, userId) : null;
  if (!doc)
    return (
      <Section title={card.definition.title}>
        <div className="lt-stack">
          <p>
            <Copy k="sheetNotIssued" />
          </p>
          <ol className="lt-stack" aria-label={t('requirementsLabel')}>
            {certificateLessons(card, lessons).map((row, index) => (
              <li key={row.slug} className="lt-actions">
                <span>{index + 1}</span>
                <strong lang={row.lesson ? 'und' : 'zxx'}>{row.lesson?.title ?? row.slug}</strong>
                <LessonStatusChip status={row.recorded ? 'recorded' : 'pending'} />
              </li>
            ))}
          </ol>
        </div>
      </Section>
    );
  return (
    <Section title={t('sheetPanel')}>
      <div className="lt-stack" data-certificate-sheet={doc.certId}>
        <article
          className="lt-print-sheet"
          aria-label={t('sheetLabel', { title: doc.design?.title ?? doc.title })}
          data-design-revision={doc.design?.revision ?? ''}
        >
          <small className="lt-muted">
            <Copy k="sheetIssuer" />
          </small>
          {doc.design ? (
            <SheetDesign design={doc.design} />
          ) : (
            <>
              <h2 lang="und">{doc.title}</h2>
              <p>
                <Copy k="sheetBody" params={{ count: doc.requirements }} />
              </p>
            </>
          )}
          {doc.code && <SheetHolder code={doc.code} />}
          <p>
            <Copy k="sheetIssued" params={{ date: formatDay(doc.issuedAt, language) }} />
          </p>
          {doc.code && (
            <>
              <p data-testid="certificate-serial">
                {t('sheetSerial')} <code lang="zxx">{doc.code}</code>
              </p>
              <small className="lt-muted">
                <Copy k="sheetVerifyHint" />
              </small>
            </>
          )}
        </article>
        <CertificateXp certId={doc.certId} />
        <ShareCertificate key={doc.code ?? doc.certId} code={doc.code} />
        {doc.code && (
          <div className="lt-actions">
            <Button tone="secondary" onClick={() => onCheckCode(doc.code!)}>
              <Copy k="useCode" />
            </Button>
          </div>
        )}
        {/* Outside the printed sheet on purpose: the account id and the grant reference are private record keys. */}
        <details className="lt-muted">
          <summary>
            <Copy k="sheetPrivate" />
          </summary>
          <KitDetails
            items={[
              [t('sheetAccount'), <code lang="zxx">{doc.holder}</code>],
              [t('sheetReference'), <code lang="zxx">{doc.reference}</code>],
            ]}
          />
        </details>
      </div>
    </Section>
  );
}

/** The design revision the certificate was issued under, as staff wrote it: every line is theirs, in its own language. */
function SheetDesign({ design }: { design: NonNullable<CertGrant['design']> }) {
  const { t } = copy.useCopy();
  return (
    <div className="lt-stack" data-testid="certificate-design">
      <h2 lang={design.language}>{design.title}</h2>
      <p lang={design.language}>{design.body}</p>
      {design.effortHours && <p>{t('sheetEffort', { hours: design.effortHours })}</p>}
      {design.signatories.length > 0 && (
        <div data-testid="certificate-signatories">
          <small className="lt-muted">{t('sheetSignedBy')}</small>
          <ul className="lt-list">
            {design.signatories.map((s, i) => (
              <li key={i}>
                <strong lang="und">{s.name}</strong>{' '}
                <span className="lt-muted" lang={design.language}>
                  {s.role}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {design.disclaimer && (
        <small className="lt-muted" lang={design.language} data-testid="certificate-disclaimer">
          {design.disclaimer}
        </small>
      )}
      <small className="lt-muted" data-testid="certificate-design-revision">
        {t('sheetRevision', { revision: design.revision })}
      </small>
    </div>
  );
}

/**
 * What this certificate did to the holder's rank, from the XP Academy publishes for it. Perks come from the rank in
 * identity, never from the certificate, so none is named here. A failed read shows its refusal, never a number.
 */
function CertificateXp({ certId }: { certId: string }) {
  const api = useApi();
  const { t } = copy.useCopy();
  const plane = useResource((signal) => api.call(ACADEMY_CERT_XP_PLANE, undefined, { signal }), 'cert-xp-plane');
  if (plane.resource.status === 'loading') return <Waiting />;
  if (plane.resource.status === 'failed') return <AcademyRefusal failure={plane.resource.failure} retry={plane.reload} />;
  const xp = certificateXp(plane.resource.data, certId);
  return (
    <p data-testid="certificate-xp">
      <span data-testid="certificate-xp-text">
        {xp.kind === 'none' ? t('certXpNone') : t(xp.kind === 'worth' ? 'certXpWorth' : 'certXpOff', { xp: xp.xp })}
      </span>{' '}
      <a className="lt-link lt-link-alone" href="/uc/account">
        {t('seeRank')}
      </a>
    </p>
  );
}

/**
 * Share a certificate. No share targets are set by the owner, so the ways offered are the certificate's public link and
 * print; no partner is named. Copying says whether it worked, and shows the link when the browser refused.
 */
function ShareCertificate({ code }: { code: string | null }) {
  const { t } = copy.useCopy();
  const [copied, setCopied] = useState<'idle' | 'copied' | 'refused'>('idle');
  const link = code ? `${window.location.origin}${academyVerifyHref(code)}` : null;
  return (
    <div className="lt-stack" data-testid="certificate-share">
      <p className="lt-muted">{t('shareTargetsNone')}</p>
      <div className="lt-actions">
        {link && (
          <Button
            tone="secondary"
            onClick={() => {
              if (!navigator.clipboard) return setCopied('refused');
              void navigator.clipboard.writeText(link).then(
                () => setCopied('copied'),
                () => setCopied('refused'),
              );
            }}
          >
            {t('copyLink')}
          </Button>
        )}
        <Button tone="primary" onClick={() => window.print()}>
          {t('printShort')}
        </Button>
      </div>
      {copied !== 'idle' && link && <p role="status">{copied === 'copied' ? t('linkCopied') : t('copyRefused', { link })}</p>}
    </div>
  );
}

/**
 * `/academy/certificates/verify/<code>`: the page a shared certificate link opens, signed in or not. It shows exactly what
 * Academy's public check answers for the code (valid or revoked, with the issue date) or its typed refusal.
 */
export function CertificateVerifyPage({ code }: { code: string | undefined }) {
  const { t } = copy.useCopy();
  const parsed = parseVerifyCode(code ?? '');
  return (
    <Section title={t('verifyPageTitle')}>
      <div className="lt-stack" data-certificate-verify={parsed.kind === 'code' ? parsed.code : ''}>
        <p className="lt-muted">{t('verifyPageIntro')}</p>
        {parsed.kind === 'code' ? (
          <VerifyAnswer code={parsed.code} />
        ) : (
          <p role="status">{(code ?? '').trim() ? t('verifyFormat') : t('verifyPageNoCode')}</p>
        )}
      </div>
    </Section>
  );
}

function VerifyAnswer({ code }: { code: string }) {
  const api = useApi();
  const { t } = copy.useCopy();
  const answer = useResource((signal) => verifyCertificate(api, code, signal), `certificate-verify:${code}`);
  if (answer.resource.status === 'loading') return <Waiting label={t('verifyChecking')} />;
  if (answer.resource.status === 'failed')
    return (
      <div data-code={academyCodeOf(answer.resource.failure) ?? undefined}>
        <AcademyRefusal failure={answer.resource.failure} retry={answer.reload} />
      </div>
    );
  return <VerifyResult code={code} certificate={answer.resource.data} />;
}

/** The holder as the public check shows it: the name only when the holder agreed to share it. Nothing is shown while that is unknown. */
export function SheetHolder({ code }: { code: string }) {
  const api = useApi();
  const { t } = copy.useCopy();
  const holder = useResource((signal) => verifyCertificate(api, code, signal), `sheet-holder:${code}`);
  if (holder.resource.status !== 'ready') return null;
  const name = holder.resource.data.holderName;
  return (
    <p>
      <small className="lt-muted">{t('verifyHolder')}</small>
      <br />
      {name ? <span lang="und">{name}</span> : t('holderNotShared')}
    </p>
  );
}

const VERIFY_FIELD = 'academy-verify-code';

type Lookup =
  { status: 'idle' } | { status: 'checking'; code: string } | { status: 'done'; code: string; result: ApiResult<VerifiedCertificate> };

/** What Academy says about one verification code. Every field is the service's answer. */
export function VerifyResult({ code, certificate }: { code: string; certificate: VerifiedCertificate }) {
  const { t, Copy } = copy.useCopy();
  const { language } = usePreferences();
  const revoked = certificate.status === 'revoked';
  return (
    <section className="lt-stack" role="status" aria-label={t('verifyResultLabel')}>
      <KitDetails
        items={[
          [t('verifyCertificate'), <span lang="und">{certificate.title}</span>],
          [t('verifyHolder'), certificate.holderName ? <span lang="und">{certificate.holderName}</span> : t('holderNotShared')],
          [t('verifyIssued'), <span data-testid="verify-issued">{formatDay(certificate.grantedAt, language)}</span>],
          [
            t('verifyStatus'),
            <span className="lt-chip" data-status={revoked ? 'revoked' : 'recorded'} data-testid="verify-status">
              <span className="lt-chip-mark" aria-hidden="true" />
              {revoked ? t('verifyRevoked') : t('verifyValid')}
            </span>,
          ],
          [t('sheetCode'), <code lang="zxx">{code}</code>],
        ]}
      />
      {revoked ? (
        <p>
          <Copy k="verifyRevokedNote" />
        </p>
      ) : (
        <p className="lt-muted">
          <Copy k="verifyValidNote" />
        </p>
      )}
    </section>
  );
}

/**
 * Check a certificate by its verification code with Academy's public lookup (certVerify). Nothing is matched against
 * this account: the answer is what anyone with the code would see. Malformed and unknown codes get the same refusal.
 */
export function VerifyPanel({ reference, onReference }: { reference: string; onReference: (value: string) => void }) {
  const api = useApi();
  const { t, Copy } = copy.useCopy();
  const [lookup, setLookup] = useState<Lookup>({ status: 'idle' });
  const controller = useRef<AbortController | null>(null);
  const parsed = parseVerifyCode(reference);
  const trimmed = reference.trim();

  async function check(code: string) {
    controller.current?.abort();
    const mine = new AbortController();
    controller.current = mine;
    setLookup({ status: 'checking', code });
    const result = await verifyCertificate(api, code, mine.signal);
    if (mine.signal.aborted) return;
    setLookup({ status: 'done', code, result });
  }
  // A link such as /academy/certificates?verify=<code> checks the code it carries.
  useEffect(() => {
    const first = parseVerifyCode(param('verify'));
    if (first.kind === 'code') void check(first.code);
    return () => controller.current?.abort();
  }, []);

  const reason = lookup.status === 'checking' ? t('verifyChecking') : parsed.kind === 'code' ? null : t('verifyNeedCode');
  return (
    <Section title={t('verifyTitle')}>
      <form
        className="lt-stack"
        onSubmit={(event) => {
          event.preventDefault();
          if (parsed.kind === 'code' && lookup.status !== 'checking') void check(parsed.code);
        }}
      >
        <p className="lt-muted">
          <Copy k="verifyIntro" />
        </p>
        <Field
          id={VERIFY_FIELD}
          label={t('verifyField')}
          value={reference}
          onChange={(event) => onReference(event.target.value)}
          maxLength={120}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          error={
            trimmed && parsed.kind === 'invalid'
              ? t('verifyFormat')
              : trimmed && parsed.kind === 'grant-reference'
                ? t('verifyGrantReference')
                : undefined
          }
        />
        <GuardedButton type="submit" reasonId="academy-verify-reason" reason={reason}>
          {t('verifyAction')}
        </GuardedButton>
        {lookup.status === 'checking' && <Waiting label={t('verifyChecking')} />}
        {lookup.status === 'done' && !lookup.result.ok && <AcademyRefusal failure={lookup.result} retry={() => void check(lookup.code)} />}
        {lookup.status === 'done' && lookup.result.ok && <VerifyResult code={lookup.code} certificate={lookup.result.data} />}
      </form>
    </Section>
  );
}

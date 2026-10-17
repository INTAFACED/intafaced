import { useState } from 'react';
import { Button, Field, Panel } from '../../shared/ui';
import { usePreferences } from '../../shared/preferences';
import { useSession } from '../session/session';
import { Details, Read } from './common';
import { academyLmsCopy as copy } from './academy-lms-copy';
import {
  certificateCards,
  certificateDocument,
  certificateLessons,
  formatDay,
  lessonHrefFor,
  parseVerifyReference,
  type CertificateCard,
  type LessonSummary,
  type Tracking,
} from './academy-lms';
import { useAcademyTracking } from './academy-tracking';
import { CertificateChip, DisabledWithReason, ProgressBar, StatusChip } from './AcademyLmsParts';

const param = (name: string) => new URLSearchParams(window.location.search).get(name) ?? '';

/** Certificates tab: every published certificate with its real state, the printable document, and the verify box. */
export function CertificateShelf() {
  const overview = useAcademyTracking();
  return (
    <Read resource={overview.resource} retry={overview.reload}>
      {(data) => <Shelf lessons={data.lessons} tracking={data.tracking} />}
    </Read>
  );
}

function Shelf({ lessons, tracking }: { lessons: readonly LessonSummary[]; tracking: Tracking }) {
  const { t, Copy } = copy.useCopy();
  const cards = certificateCards(tracking);
  const earned = cards.filter((c) => c.state === 'earned');
  const [viewId, setViewId] = useState(param('view') || earned[0]?.definition.id || '');
  const view = cards.find((c) => c.definition.id === viewId);
  if (cards.length === 0)
    return (
      <Panel title={t('shelfTitle')}>
        <p>
          <Copy k="shelfEmpty" />
        </p>
      </Panel>
    );
  return (
    <div className="academy-lms-stack">
      <Panel title={t('shelfTitle')}>
        <div className="academy-lms-stack">
          <p role="status">
            <Copy k="shelfSummary" params={{ earned: earned.length, total: cards.length }} />
          </p>
          <div className="academy-lms-grid">
            {cards.map((card) => (
              <CertificateCardView key={card.definition.id} card={card} lessons={lessons} onView={() => setViewId(card.definition.id)} />
            ))}
          </div>
        </div>
      </Panel>
      {view && <CertificateSheet card={view} lessons={lessons} />}
      <VerifyPanel tracking={tracking} />
    </div>
  );
}

function CertificateCardView({ card, lessons, onView }: { card: CertificateCard; lessons: readonly LessonSummary[]; onView: () => void }) {
  const { t, Copy } = copy.useCopy();
  const { language } = usePreferences();
  const required = card.progress?.requiredCount ?? card.definition.requiredItemSlugs.length;
  const missing = card.progress?.missingItemSlugs[0];
  const missingLesson = lessons.find((l) => l.slug === missing);
  return (
    <article className="academy-lms-card">
      <h3 lang="und">{card.definition.title}</h3>
      <div className="academy-lms-meta">
        <CertificateChip state={card.state} />
      </div>
      <ProgressBar percent={card.percent} label={t('certProgressLabel', { title: card.definition.title })} />
      <p>
        <Copy k="requiredRecorded" params={{ completed: card.progress?.completedCount ?? 0, required }} />
      </p>
      {card.grant && (
        <p className="muted">
          <Copy k="issuedOn" params={{ date: formatDay(card.grant.grantedAt, language) }} />
        </p>
      )}
      <div className="academy-learning-actions">
        {card.state === 'earned' && (
          <Button variant="secondary" onClick={onView}>
            <Copy k="viewCertificate" />
          </Button>
        )}
        {card.state !== 'earned' && missing && (
          <a className="academy-learning-link" href={lessonHrefFor(missing, card.definition.id, missingLesson?.path)}>
            <Copy k="continueLearning" />
          </a>
        )}
        {card.state === 'ready' && (
          <p className="muted">
            <Copy k="readyHint" />
          </p>
        )}
      </div>
    </article>
  );
}

function CertificateSheet({ card, lessons }: { card: CertificateCard; lessons: readonly LessonSummary[] }) {
  const { t, Copy } = copy.useCopy();
  const { userId } = useSession();
  const { language } = usePreferences();
  const doc = userId ? certificateDocument(card, userId) : null;
  if (!doc)
    return (
      <Panel title={card.definition.title}>
        <div className="academy-lms-stack">
          <p>
            <Copy k="sheetNotIssued" />
          </p>
          <ul className="academy-lms-rows" aria-label={t('requirementsLabel')}>
            {certificateLessons(card, lessons).map((row, index) => (
              <li key={row.slug}>
                <span>{index + 1}</span>
                <strong lang={row.lesson ? 'und' : 'zxx'}>{row.lesson?.title ?? row.slug}</strong>
                <StatusChip status={row.recorded ? 'recorded' : 'pending'} />
              </li>
            ))}
          </ul>
        </div>
      </Panel>
    );
  return (
    <Panel title={t('sheetPanel')}>
      <div className="academy-lms-stack">
        <article className="academy-cert-sheet" aria-label={t('sheetLabel', { title: doc.title })}>
          <small className="muted">
            <Copy k="sheetIssuer" />
          </small>
          <h2 lang="und">{doc.title}</h2>
          <p>
            <Copy k="sheetBody" params={{ count: doc.requirements }} />
          </p>
          <code lang="zxx">{doc.holder}</code>
          <p>
            <Copy k="sheetIssued" params={{ date: formatDay(doc.issuedAt, language) }} />
          </p>
          <small>
            <Copy k="sheetReference" />: <code lang="zxx">{doc.reference}</code>
          </small>
          <small className="muted">
            <Copy k="sheetBoundary" />
          </small>
        </article>
        <div className="academy-learning-actions">
          <Button onClick={() => window.print()}>
            <Copy k="printCertificate" />
          </Button>
        </div>
      </div>
    </Panel>
  );
}

/**
 * Verify by certificate reference. Academy can only read the caller's own grants; it has no public lookup,
 * so a reference is only matched against this account, and the public check stays disabled with its reason.
 */
function VerifyPanel({ tracking }: { tracking: Tracking }) {
  const { t, Copy } = copy.useCopy();
  const { language } = usePreferences();
  const [reference, setReference] = useState(param('verify'));
  const trimmed = reference.trim();
  const parsed = trimmed ? parseVerifyReference(trimmed) : null;
  const own = trimmed ? tracking.grants.find((g) => g.idempotencyKey === trimmed) : undefined;
  const ownTitle = own ? (tracking.definitions.find((d) => d.id === own.certId)?.title ?? own.certId) : '';
  return (
    <Panel title={t('verifyTitle')}>
      <div className="academy-lms-stack">
        <p className="muted">
          <Copy k="verifyIntro" />
        </p>
        <Field
          label={t('verifyField')}
          value={reference}
          onChange={(event) => setReference(event.target.value)}
          maxLength={120}
          autoComplete="off"
          spellCheck={false}
        />
        {trimmed && !parsed?.ok && (
          <p role="status">
            <Copy k="verifyFormat" />
          </p>
        )}
        {own && (
          <p role="status">
            <Copy k="verifyOwn" params={{ title: ownTitle, date: formatDay(own.grantedAt, language) }} />
          </p>
        )}
        {parsed?.ok && !own && (
          <p role="status">
            <Copy k="verifyUnknownOwn" />
          </p>
        )}
        <DisabledWithReason id="academy-verify-reason" label={t('verifyPublic')} reason={t('verifyReason')} />
        <section className="academy-cert-sheet" aria-disabled="true" aria-label={t('verifyResultLabel')}>
          <Details
            items={[
              [t('verifyHolder'), t('notAvailable')],
              [t('verifyCertificate'), own ? ownTitle : t('notAvailable')],
              [t('verifyIssued'), own ? formatDay(own.grantedAt, language) : t('notAvailable')],
              [t('verifyStatus'), own ? t('verifyStatusOwn') : t('notAvailable')],
            ]}
          />
        </section>
      </div>
    </Panel>
  );
}

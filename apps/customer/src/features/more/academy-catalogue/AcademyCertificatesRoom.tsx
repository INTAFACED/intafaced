// volt-room: /academy/certificates
import { copy as moreCopy, t as copyText, Text } from '../copy';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Button } from '@intafaced/ui/lit';
import { CatalogueTemplate, SelectField } from '@intafaced/ui/lit/templates';
import { useApi, useSession } from '../../session';
import { useResource } from '../../../shared/resource';
import { presentActionFailure } from '../common';
import { KitDetails } from '../volt-action';
import { KitRead, Section } from '../volt-parts';
import { useKitAcademyAction, type KitAcademyAction } from '../academy-reader/academy-action-kit';
import { AcademyGrantRecords } from '../AcademyGrantRecords';
import { CertificateShelf, VerifyPanel } from '../AcademyCertificates';
import { AcademyVisitor, academyCatalogue } from './frame';
import { SignInNeeded } from './SignInNeeded';
import { replyAccepted } from '@intafaced/contracts/procedure';
import {
  ACADEMY_CERT_DEFINITIONS,
  ACADEMY_CERT_PROGRESS,
  ACADEMY_ENROLL_CERT_PATH,
  ACADEMY_GRANT_CERT,
  academyCertGrantSchema,
  type AcademyCertGrant,
} from '@intafaced/contracts/academy-learner-procedures';
import { definitionsHold, progressFits, lessonHref, selectedCertificate, rememberCertificate } from '../academy-learning-state';
import { academyLearningCopy } from '../academy-learning-copy';

/**
 * /academy/certificates on the catalogue template, like the other four tabs (intafaced issue 10317): the certificate
 * shelf, grant records, path enrolment and the chosen path's progress. Signed out it says certificates need sign-in and
 * keeps the public certificate check.
 */
export function AcademyCertificatesRoom({ signedIn }: { signedIn: boolean }) {
  if (!signedIn) return <VisitorCertificates />;
  return <SignedInCertificates />;
}

function VisitorCertificates() {
  // Checking a certificate's code needs no account: the verify box is the same one signed-in learners use.
  const [reference, setReference] = useState(new URLSearchParams(location.search).get('verify') ?? '');
  return (
    <AcademyVisitor signedIn={false}>
      <CatalogueTemplate
        {...academyCatalogue({ current: 'Certificates' })}
        items={
          <div className="lt-stack">
            <SignInNeeded title={copyText('academy.certificates')} reason="publicCertificatesSignIn" />
            <VerifyPanel reference={reference} onReference={setReference} />
          </div>
        }
      />
    </AcademyVisitor>
  );
}

function SignedInCertificates() {
  const { userId } = useSession();
  const action = useKitAcademyAction();
  const [selection, setSelection] = useState({ owner: userId, id: selectedCertificate(userId) });
  const selected = selection.owner === userId ? selection.id : selectedCertificate(userId);
  useEffect(() => {
    rememberCertificate(userId, selected);
  }, [userId, selected]);
  function chooseCertificate(id: string) {
    action.retire();
    rememberCertificate(userId, id);
    setSelection({ owner: userId, id });
  }
  return (
    <>
      <AcademyVisitor signedIn>
        <CatalogueTemplate
          {...academyCatalogue({ current: 'Certificates', onLeave: action.retire })}
          items={
            <div className="lt-stack">
              <Certificates selected={selected} setSelected={chooseCertificate} action={action} />
              {action.feedback}
            </div>
          }
        />
      </AcademyVisitor>
      {action.dialog}
    </>
  );
}

/** The grant this screen asked for: this account's, for the certificate chosen, under its one grant key. */
const grantIsMine = (userId: string | null | undefined, certId: string) => (r: AcademyCertGrant) =>
  r.grant.userId === userId && r.grant.certId === certId && r.grant.idempotencyKey === `cert:${userId}:${certId}`;
function Certificates({
  action,
  selected,
  setSelected,
}: {
  action: KitAcademyAction;
  selected: string;
  setSelected: (id: string) => void;
}) {
  const api = useApi(),
    { userId } = useSession();
  const [enrolPath, setEnrolPath] = useState('foundations');
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const context = useRef({ userId, selected, enrolPath });
  context.current = { userId, selected, enrolPath };
  const unchanged = (expected: typeof context.current) =>
    mounted.current &&
    action.isCurrent() &&
    api.canWrite() &&
    context.current.userId === expected.userId &&
    context.current.selected === expected.selected &&
    context.current.enrolPath === expected.enrolPath;
  const changed = () =>
    presentActionFailure(
      { ok: false as const, reason: 'aborted' as const, message: copyText('common.the.account.or.pending.request.changed.review') },
      (locale) => {
        const presented = moreCopy.forLocale(locale);
        return {
          message: presented.t('common.the.account.or.pending.request.changed.review'),
          language: presented.languageFor('common.the.account.or.pending.request.changed.review'),
        };
      },
    );
  const receipt = action.result?.ok
    ? academyCertGrantSchema
        .refine((r) => replyAccepted(ACADEMY_GRANT_CERT, r) && grantIsMine(userId, selected)(r))
        .safeParse(action.result.data)
    : null;
  const definitions = useResource(
    (signal) => api.call(ACADEMY_CERT_DEFINITIONS, undefined, { signal, accept: definitionsHold }),
    `cert-defs:${userId}`,
  );
  const selectedDefinition = definitions.resource.status === 'ready' ? definitions.resource.data.find((c) => c.id === selected) : undefined;
  const currentDefinition = useRef<string | null>(null);
  currentDefinition.current = selectedDefinition ? JSON.stringify(selectedDefinition.requiredItemSlugs) : null;
  useLayoutEffect(() => {
    action.retire();
  }, [selected, currentDefinition.current]);
  const detail = useResource(
    (signal) =>
      selectedDefinition
        ? api.call(
            ACADEMY_CERT_PROGRESS,
            { certId: selected },
            {
              signal,
              accept: progressFits(userId, selected, selectedDefinition.requiredItemSlugs),
            },
          )
        : Promise.resolve({ ok: true as const, data: null }),
    `cert-progress:${userId}:${selected}:${currentDefinition.current ?? ''}`,
  );
  return (
    <div className="lt-stack">
      <CertificateShelf />
      <AcademyGrantRecords
        action={action}
        titles={new Map(definitions.resource.status === 'ready' ? definitions.resource.data.map((row) => [row.id, row.title]) : [])}
      />
      <div className="lt-stack">
        <Section title={copyText('academy.certificate.paths')}>
          <SelectField
            label={copyText('academy.path.to.enrol.in')}
            value={enrolPath}
            onChange={(next) => {
              action.retire();
              setEnrolPath(next);
            }}
            options={['foundations', 'markets', 'builder', 'sovereign']}
          />
          <Button
            disabled={action.disabled}
            onClick={() => {
              const expected = { ...context.current };
              action.stage({
                title: () => copyText('academy.review.path.enrolment'),
                confirm: () => copyText('academy.enrol.in.path'),
                success: () => copyText('academy.enrolment.recorded'),
                content: () => (
                  <p>
                    <Text k="academy.enrol.in" />
                    <span lang="zxx">{expected.enrolPath}</span>
                    <Text k="academy.for.this.account" />
                  </p>
                ),
                run: async (canDispatch) => {
                  if (!canDispatch() || !unchanged(expected)) return changed();
                  return api.call(
                    ACADEMY_ENROLL_CERT_PATH,
                    { pathSlug: expected.enrolPath },
                    { accept: (r) => r.userId === expected.userId && r.pathSlug === expected.enrolPath },
                  );
                },
                done: () => {
                  if (unchanged(expected)) detail.reload();
                },
              });
            }}
          >
            <Text k="academy.review.enrolment" />
          </Button>
          <KitRead
            resource={definitions.resource}
            retry={definitions.reload}
            empty={copyText('academy.no.certificate.paths.are.published')}
          >
            {(rows) => (
              <div className="lt-stack">
                {rows.map((c) => (
                  <article key={c.id}>
                    <h3 lang="und">{c.title}</h3>
                    <p>
                      {c.requiredItemSlugs.length}
                      <Text k="academy.required.learning.items" />
                    </p>
                    <Button tone="secondary" onClick={() => setSelected(c.id)}>
                      <Text k="academy.open" />
                      {c.title}
                    </Button>
                  </article>
                ))}
              </div>
            )}
          </KitRead>
        </Section>
        <Section title={copyText('academy.your.progress')}>
          <KitRead resource={detail.resource} retry={detail.reload} empty={copyText('academy.choose.a.certificate.path')}>
            {(p) =>
              p && selectedDefinition ? (
                <>
                  <h2 lang="und">{p.title}</h2>
                  <KitDetails
                    items={[
                      [
                        copyText('academy.completed'),
                        copyText('common.progress.count', { completed: p.completedCount, required: p.requiredCount }),
                      ],
                      [copyText('academy.ratio'), p.ratio],
                      [copyText('academy.granted'), copyText(p.granted ? 'common.yes' : 'common.no')],
                    ]}
                  />
                  {p.missingItemSlugs[0] && (
                    <a className="lt-link" href={lessonHref(p.missingItemSlugs[0], selected)}>
                      <academyLearningCopy.Copy k="readNext" />
                    </a>
                  )}
                  <ul>
                    {p.missingItemSlugs.map((s) => (
                      <li key={s}>
                        <a className="lt-link" href={lessonHref(s, selected)} lang="zxx">
                          {s}
                        </a>
                      </li>
                    ))}
                  </ul>
                  <Button
                    disabled={action.disabled || !selectedDefinition || (!p.complete && !p.granted)}
                    onClick={() => {
                      const expected = { ...context.current };
                      const required = [...selectedDefinition.requiredItemSlugs];
                      const definition = JSON.stringify(required);
                      const grantUnchanged = () => unchanged(expected) && currentDefinition.current === definition;
                      let dispatched = false;
                      action.stage({
                        title: () => copyText('academy.review.certification.grant'),
                        confirm: () =>
                          p.granted ? copyText('academy.recover.certification.award') : copyText('academy.request.certification'),
                        success: () => copyText('academy.certification.outcome.received.xp.delivery.is.shown'),
                        content: () => (
                          <p>
                            <Text k="academy.the.service.checks.completed.items.and.issues" />
                          </p>
                        ),
                        reference: `cert:${expected.userId}:${expected.selected}`,
                        grant: { certId: expected.selected, dispatched: () => dispatched },
                        run: async (canDispatch) => {
                          if (!canDispatch() || !grantUnchanged()) return changed();
                          const fresh = await api.call(
                            ACADEMY_CERT_PROGRESS,
                            { certId: expected.selected },
                            { accept: progressFits(expected.userId, expected.selected, required) },
                          );
                          if (!canDispatch() || !grantUnchanged()) return changed();
                          if (!fresh.ok) return fresh;
                          if (!fresh.data.complete && !fresh.data.granted)
                            return presentActionFailure(
                              { ok: false as const, reason: 'aborted' as const, message: academyLearningCopy.t('progressChanged') },
                              (locale) => {
                                const presented = academyLearningCopy.forLocale(locale);
                                return { message: presented.t('progressChanged'), language: presented.languageFor('progressChanged') };
                              },
                            );
                          dispatched = true;
                          return api.call(
                            ACADEMY_GRANT_CERT,
                            { certId: expected.selected },
                            { accept: grantIsMine(expected.userId, expected.selected) },
                          );
                        },
                        done: () => {
                          if (unchanged(expected)) detail.reload();
                        },
                      });
                    }}
                  >
                    {p.granted ? copyText('academy.recover.certification.award') : copyText('academy.request.certification')}
                  </Button>
                </>
              ) : null
            }
          </KitRead>
          {receipt?.success && (
            <section aria-label={copyText('academy.certification.receipt')}>
              <h3>
                <Text k="academy.certification.receipt" />
              </h3>
              <KitDetails
                items={[
                  [copyText('academy.certification'), <code lang="zxx">{receipt.data.grant.certId}</code>],
                  [
                    copyText('academy.granted'),
                    <time lang="zxx" dateTime={receipt.data.grant.grantedAt}>
                      {receipt.data.grant.grantedAt}
                    </time>,
                  ],
                  [copyText('common.acting.as.account'), <code lang="zxx">{receipt.data.grant.userId}</code>],
                  [academyLearningCopy.t('grantReference'), <code lang="zxx">{receipt.data.grant.idempotencyKey}</code>],
                  [copyText('academy.already.granted'), copyText(receipt.data.alreadyGranted ? 'common.yes' : 'common.no')],
                  [
                    copyText('academy.xp.delivery'),
                    receipt.data.xp.emitted ? (
                      <academyLearningCopy.Copy k="xpPublished" params={{ xp: receipt.data.xp.xpDelta }} />
                    ) : (
                      <>
                        <academyLearningCopy.Copy k="xpNotPublished" />: <code lang="zxx">{receipt.data.xp.reason}</code>
                      </>
                    ),
                  ],
                  [
                    copyText('academy.perks'),
                    receipt.data.perks.status === 'real' ? (
                      copyText('academy.authoritative.identity.rank.perks.returned.academy.holds')
                    ) : (
                      <span lang="und">{receipt.data.perks.message}</span>
                    ),
                  ],
                ]}
              />
              <p className="lt-muted">
                <academyLearningCopy.Copy k="xpPublishedBoundary" />
              </p>
            </section>
          )}
        </Section>
      </div>
    </div>
  );
}

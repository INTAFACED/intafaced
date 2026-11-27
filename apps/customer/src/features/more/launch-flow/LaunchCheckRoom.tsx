// volt-room: /launch/check
import { useState } from 'react';
import { AGENTS_LAUNCH_ASSESS } from '@intafaced/contracts/agents-launch-procedures';
import { Button, Field } from '@intafaced/ui/lit';
import { FlowTemplate, Tabs } from '@intafaced/ui/lit/templates';
import type { ApiResult } from '../../../shared/api';
import { useApi, useSession } from '../../session';
import { launchCatalogueCopy } from '../launch-catalogue-copy';
import { launchCopy } from '../launch-copy';
import { launchDepthCopy } from '../launch-depth-copy';
import type { AssessResult } from '../launch-journey';
import { moreRoomRoutesCopy } from '../more-room-routes-copy';
import { SessionRetryNote, SignInNote } from '../sign-in-note';
import { preservePaperHref } from '../trade-context';
import { Section } from '../volt-parts';

/** The Launch room's sections, each at its own address (MoreRoutes' SECTION_TABS). */
const SECTIONS = [
  { href: '/launch', key: 'catalogue' },
  { href: '/launch/new', key: 'tabJourney' },
  { href: '/launch/check', key: 'tabCheck' },
  { href: '/launch/requirements', key: 'tabRequirements' },
  { href: '/launch/mine', key: 'tabParticipation' },
] as const;

/**
 * `/launch/check` on the flow template: the pre-listing deployer check (`AGENTS_LAUNCH_ASSESS`). Private to a
 * signed-in account: signed out shows the shared sign-in panel returning here.
 */
export function LaunchCheckRoom({ paper }: { paper: boolean }) {
  const api = useApi();
  const { t: scopeT } = launchCopy.useCopy();
  const { Copy, t } = launchDepthCopy.useCopy();
  const catalogue = launchCatalogueCopy.useCopy();
  const routes = moreRoomRoutesCopy.useCopy();
  const { userId, restoreFailed, retryRestore } = useSession();
  const [deployer, setDeployer] = useState('');
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<ApiResult<AssessResult> | null>(null);

  async function run() {
    setBusy(true);
    const result = await api.call(AGENTS_LAUNCH_ASSESS, { deployer: deployer.trim() || undefined });
    setOutcome(result);
    setBusy(false);
  }

  return (
    <FlowTemplate
      title={routes.t('launchCheck')}
      description={scopeT('scope')}
      state={{ kind: 'ready' }}
      step={
        <div className="lt-stack">
          <Tabs
            label={t('sections')}
            current={preservePaperHref('/launch/check', paper)}
            items={SECTIONS.map((s) => ({
              href: preservePaperHref(s.href, paper),
              label: s.key === 'catalogue' ? catalogue.t('tabCatalogue') : t(s.key),
            }))}
          />
          {!userId ? (
            restoreFailed ? (
              <SessionRetryNote retry={retryRestore} />
            ) : (
              <SignInNote returnTo="/launch/check" />
            )
          ) : (
            <Section title={t('checkTitle')} className="lt-stack">
              <p className="lt-muted">
                <Copy k="checkIntro" />
              </p>
              <form
                className="lt-stack"
                onSubmit={(event) => {
                  event.preventDefault();
                  void run();
                }}
              >
                <Field label={t('deployer')} value={deployer} maxLength={128} onChange={(e) => setDeployer(e.target.value)} />
                <div className="lt-actions">
                  <Button tone="primary" type="submit" disabled={busy || !deployer.trim()}>
                    {busy ? <Copy k="checking" /> : <Copy k="runCheck" />}
                  </Button>
                </div>
              </form>
              {outcome && !outcome.ok ? (
                <p className="lt-refusal" role="alert">
                  {outcome.message}
                </p>
              ) : null}
              {outcome?.ok && outcome.data.status === 'refuse' ? (
                <div className="lt-stack" role="status">
                  <h3>
                    <Copy k="resultRefuse" />
                  </h3>
                  <p>
                    <Copy k={`refuse_${outcome.data.reason}`} />
                  </p>
                </div>
              ) : null}
              {outcome?.ok && outcome.data.status === 'annotation' ? (
                <div className="lt-stack" role="status">
                  <h3>
                    <Copy k="resultAnnotation" />
                  </h3>
                  <dl className="lt-kv">
                    <div>
                      <dt>{t('lpLocks')}</dt>
                      <dd>{outcome.data.lpLocks}</dd>
                    </div>
                    <div>
                      <dt>{t('vestings')}</dt>
                      <dd>{outcome.data.vestings}</dd>
                    </div>
                  </dl>
                  <h3>
                    <Copy k="flags" />
                  </h3>
                  {outcome.data.patternFlags.length ? (
                    <ul>
                      {outcome.data.patternFlags.map((flag) => (
                        <li key={flag.code}>
                          <Copy k={`flag_${flag.code}`} />
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p>
                      <Copy k="noFlags" />
                    </p>
                  )}
                </div>
              ) : null}
            </Section>
          )}
        </div>
      }
    />
  );
}

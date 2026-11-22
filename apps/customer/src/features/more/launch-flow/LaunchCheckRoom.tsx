import { useState } from 'react';
import { Button, Field } from '@intafaced/ui/lit';
import { FlowTemplate, KeyValue } from '@intafaced/ui/lit/templates';
import type { ApiResult } from '../../../shared/api';
import { useApi } from '../../session';
import { launchDepthCopy } from '../launch-depth-copy';
import { assessLaunch, type AssessResult } from '../launch-journey';
import { moreRoomRoutesCopy } from '../more-room-routes-copy';
import { LaunchTabs, useLaunchGate, useLaunchScope } from './launch-flow-parts';

/**
 * `/launch/check`: the pre-listing deployer check, on the flow template. It reads the deployer's recorded liquidity
 * locks and vestings (svc-agents `launch.assess`) and names pattern notes. It is an annotation, never a badge and never
 * a decision to block or allow; a refusal is shown by name, never as a clean result.
 */
export function LaunchCheckRoom() {
  const api = useApi();
  const { Copy, t } = launchDepthCopy.useCopy();
  const routes = moreRoomRoutesCopy.useCopy();
  const description = useLaunchScope();
  const gate = useLaunchGate('/launch/check');
  const [deployer, setDeployer] = useState('');
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<ApiResult<AssessResult> | null>(null);
  async function run() {
    setBusy(true);
    const result = await assessLaunch(api, deployer);
    setOutcome(result);
    setBusy(false);
  }
  return (
    <FlowTemplate
      title={routes.t('launchCheck')}
      description={description}
      state={gate.state ?? { kind: 'ready' }}
      roomAction={gate.retry}
      step={
        <>
          <LaunchTabs current="/launch/check" />
          <section aria-labelledby="launch-check-title">
            <h2 id="launch-check-title">{t('checkTitle')}</h2>
            <p>
              <Copy k="checkIntro" />
            </p>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void run();
              }}
            >
              <Field label={t('deployer')} value={deployer} maxLength={128} onChange={(e) => setDeployer(e.target.value)} />
              <Button type="submit" tone="primary" disabled={busy || !deployer.trim()}>
                {busy ? <Copy k="checking" /> : <Copy k="runCheck" />}
              </Button>
            </form>
          </section>
        </>
      }
      summary={
        outcome ? (
          <>
            {!outcome.ok ? <p role="alert">{outcome.message}</p> : null}
            {outcome.ok && outcome.data.status === 'refuse' ? (
              <div role="status">
                <h3>
                  <Copy k="resultRefuse" />
                </h3>
                <p>
                  <Copy k={`refuse_${outcome.data.reason}`} />
                </p>
              </div>
            ) : null}
            {outcome.ok && outcome.data.status === 'annotation' ? (
              <div role="status">
                <h3>
                  <Copy k="resultAnnotation" />
                </h3>
                <KeyValue
                  rows={[
                    { label: t('lpLocks'), value: outcome.data.lpLocks },
                    { label: t('vestings'), value: outcome.data.vestings },
                  ]}
                />
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
          </>
        ) : undefined
      }
    />
  );
}

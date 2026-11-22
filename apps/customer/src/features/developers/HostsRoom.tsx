import { ReadingTemplate } from '@intafaced/ui/lit/templates';
import { useSession } from '../session';
import { developersCopy } from './developers-copy';
import { liveCopy } from './developers-live-copy';
import { hostsView, readDeveloperHosts, readRegionalRule, regionalRuleView } from './developers-values';
import { hostRows, hostTable } from './developers-model';
import { ReadFailed, ReadLoading } from './ReadState';
import { useRead } from './use-read';

/** /developers/hosts on the reading template: every published base address by protocol and environment, and the regional rule. */
export function HostsRoom() {
  const { t } = developersCopy.useCopy();
  const { t: live } = liveCopy.useCopy();
  const { api } = useSession();
  const { read, reload } = useRead((signal) => readDeveloperHosts(api, signal), [api]);
  const view = hostsView(read);
  return (
    <div data-testid="developers-hosts">
      <ReadingTemplate
        title={t('hostsTitle')}
        description={t('hostsPageLead')}
        state={{ kind: 'ready' }}
        body={
          <section>
            {view.kind === 'loading' ? (
              <ReadLoading rows={9} label={live('loading')} />
            ) : view.kind === 'failed' ? (
              <ReadFailed title={live('loadFailed')} onRetry={reload} retryLabel={live('tryAgain')} />
            ) : (
              <>
                {view.unsetCode ? (
                  <p role="status" data-testid="developers-hosts-unset" data-code={view.unsetCode}>
                    {t('hostsUnpublished')}
                  </p>
                ) : null}
                <table className="lt-table">
                  <thead>
                    <tr>
                      <th scope="col">{t('colProtocol')}</th>
                      <th scope="col">{t('colEnvironment')}</th>
                      <th scope="col">{t('colHost')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {hostRows(hostTable(view.read)).map((row) => (
                      <tr key={`${row.protocol}:${row.environment}`} data-host-state={row.cell.state}>
                        <td>{t(`protocol_${row.protocol}` as const)}</td>
                        <td>{t(`environment_${row.environment}` as const)}</td>
                        <td>{row.cell.state === 'set' ? <code>{row.cell.host}</code> : t('hostUnset')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
            <RegionalRule />
            <a className="lt-link" href="/developers">
              ← {t('hostsBack')}
            </a>
          </section>
        }
      />
    </div>
  );
}

/** The owner's rule for the regional hosts, read from svc-trade; until it is published the page says it waits for the owner. */
function RegionalRule() {
  const { t } = developersCopy.useCopy();
  const { t: live } = liveCopy.useCopy();
  const { api } = useSession();
  const { read, reload } = useRead((signal) => readRegionalRule(api, signal), [api]);
  const view = regionalRuleView(read);
  if (view.kind === 'loading') return <ReadLoading rows={1} label={live('loading')} />;
  if (view.kind === 'failed') return <ReadFailed title={live('loadFailed')} onRetry={reload} retryLabel={live('tryAgain')} />;
  return view.kind === 'set' ? (
    <p className="lt-prose-lines" data-testid="developers-regional-rule" data-rule-state="set">
      {view.rule}
    </p>
  ) : (
    <p role="status" data-testid="developers-regional-rule" data-rule-state="unset" data-code={view.code}>
      {t('hostsRegional')}
    </p>
  );
}

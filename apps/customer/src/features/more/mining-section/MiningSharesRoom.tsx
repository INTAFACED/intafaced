// volt-room: /mining/shares
import { RecordListTemplate } from '@intafaced/ui/lit/templates';
import { displayAmount } from '../../../shared/money';
import { usePreferences } from '../../../shared/preferences';
import { stamp } from '../../../screens/money/time';
import { useMiningShares } from '../MiningRooms';
import { miningCopy } from '../mining-copy';
import { miningDepthCopy } from '../mining-depth-copy';
import { sumWeights } from '../mining-reads';
import { moreRoomRoutesCopy } from '../more-room-routes-copy';
import { EmptyNote, KitRead, ScrollTable, Section } from '../volt-parts';
import { MiningSections } from './MiningStatusRoom';

/**
 * `/mining/shares` on the record-list template: accepted and refused shares by counted window, with exact total weight
 * and the pool's share counting rule. Uses the same read and words as `../MiningRooms.tsx`.
 */
export function MiningSharesRoom({ paper }: { paper: boolean }) {
  const read = useMiningShares();
  const { Copy, t } = miningDepthCopy.useCopy();
  const scope = miningCopy.useCopy().t('scope');
  const routes = moreRoomRoutesCopy.useCopy();
  const { timeZone } = usePreferences();

  return (
    <RecordListTemplate
      title={routes.t('shares')}
      description={scope}
      state={{ kind: 'ready' }}
      filters={<MiningSections value="Shares" paper={paper} />}
      list={
        <Section title={t('sharesTitle')} className="lt-stack">
          <KitRead resource={read.resource} retry={read.reload}>
            {(data) =>
              data.windows.length === 0 ? (
                <EmptyNote title={<Copy k="sharesNone" />}>
                  <Copy k="sharesNoneBody" />
                </EmptyNote>
              ) : (
                <>
                  <dl className="lt-kv">
                    <div>
                      <dt>{t('sharesCount')}</dt>
                      <dd className="lt-num">{data.windows.reduce((sum, row) => sum + row.acceptedCount, 0)}</dd>
                    </div>
                    <div>
                      <dt>{t('sharesRejected')}</dt>
                      <dd className="lt-num">{data.windows.reduce((sum, row) => sum + row.rejectedCount, 0)}</dd>
                    </div>
                    <div>
                      <dt>{t('sharesWeight')}</dt>
                      <dd className="lt-num">
                        {(() => {
                          const total = sumWeights(data.windows.map((row) => row.acceptedWeight));
                          return total === null ? t('unknown') : displayAmount(total);
                        })()}
                      </dd>
                    </div>
                  </dl>
                  <ScrollTable
                    headers={[t('sharesWindowCol'), t('sharesAccepted'), t('sharesRefused'), t('sharesWeight')]}
                    label={t('sharesByWindow')}
                  >
                    {data.windows.map((row, index) => (
                      <tr key={row.windowId}>
                        <td>{t('sharesWindowN', { n: index + 1 })}</td>
                        <td className="lt-num">{row.acceptedCount}</td>
                        <td className="lt-num">{row.rejectedCount}</td>
                        <td className="lt-num">{row.acceptedWeight === null ? '—' : displayAmount(row.acceptedWeight)}</td>
                      </tr>
                    ))}
                  </ScrollTable>
                  <p className="lt-muted">{t('asOf', { time: stamp(data.asOf, timeZone) })}</p>
                </>
              )
            }
          </KitRead>
        </Section>
      }
      detail={
        <Section title={t('sharesRuleTitle')} className="lt-stack">
          <p className="lt-muted">
            <Copy k="sharesRule" />
          </p>
        </Section>
      }
    />
  );
}

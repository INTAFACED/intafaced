// volt-room: /bank/spaces
import { useState } from 'react';
import { Button } from '@intafaced/ui/lit';
import { OverviewTemplate } from '@intafaced/ui/lit/templates';
import { BANK_SPACES_UNNAMED } from '@intafaced/contracts/bank-spaces-procedures';
import { ReadView } from '../../../shared/read-state';
import { useSession } from '../../session';
import { BankSection, BankTabs, Continuation, NoRows, bankRoomProps } from '../bank-frame/BankFrame';
import type { Space } from '../client';
import { date, funds, useBankRecord, useSpaces, type ActionSpec } from '../components';
import { t as copyText, Text } from '../copy';
import { assetSelectField, useHoldings } from '../holdings';
import { archiveSpaceSpec, createSpaceSpec } from '../rooms';
import { spaceContext } from '../space-context';
import { spaceCopy } from '../space-copy';
import { transferDepthCopy } from '../transfer-depth-copy';
import { BillsPotActions } from './BillsPot';
import { GoalProgress } from './GoalAndMovement';
import { IncomeSorter } from './IncomeSorter';
import { InstantSavings } from './InstantSavings';
import { SelectedSpace } from './SelectedSpace';
import { SharedPots } from './SharedPots';
import { SpaceInflows } from './SpaceInflows';
import { EarlyUnlock, SpaceLockActions } from './SpaceLock';

function SpaceActions({ space, open }: { space: Space; open: (spec: ActionSpec) => void }) {
  return (
    <div className="lt-actions">
      <a className="lt-button lt-button-secondary" href={`/bank/transfers?from=${encodeURIComponent(space.id)}`}>
        <Text k="rooms.transfer" />
      </a>
      <SpaceLockActions space={space} open={open} />
      <BillsPotActions space={space} open={open} />
      {space.kind === 'named' && (
        <Button tone="quiet" onClick={() => open(archiveSpaceSpec(space))}>
          <Text k="rooms.archive.label" />
        </Button>
      )}
    </div>
  );
}

/**
 * `/bank/spaces` on the overview template: the space a link opened (`?space=`), the person's spaces with their
 * targets, locks and actions, what flows into a space, and the assets that sit in no space. Every figure is the bank's
 * answer; each change opens the money review (`open`), which the Bank's routes draw.
 */
export function SpacesRoom({ open, search }: { open: (spec: ActionSpec) => void; search: string }) {
  const { userId } = useSession();
  const context = spaceContext(search, 'space');
  const [limit, setLimit] = useState(context.status === 'valid' ? 200 : 50);
  const spaces = useSpaces(limit);
  const unnamed = useBankRecord(BANK_SPACES_UNNAMED, undefined);
  const held = useHoldings();
  const heldAssets = held.resource.status === 'ready' ? held.resource.data.assets : [];
  const depthCopy = transferDepthCopy.useCopy();
  const create = () => open(createSpaceSpec(assetSelectField(depthCopy.t('assetPicker'), depthCopy.t('assetPickerHint'), heldAssets)));
  return (
    <OverviewTemplate
      {...bankRoomProps('Spaces', copyText('rooms.give.an.asset.a.purpose.inside.the'))}
      state={{ kind: 'ready' }}
      rooms={<BankTabs current="Spaces" />}
      hero={
        <div className="lt-body">
          <SelectedSpace
            context={context}
            resource={spaces.resource}
            owner={userId ?? ''}
            reload={spaces.reload}
            actions={(space) => <SpaceActions space={space} open={open} />}
            below={(space, all) => space.kind === 'named' && <SpaceInflows key={space.id} space={space} spaces={all} open={open} />}
          />
          <BankSection
            title={context.status === 'none' ? copyText('rooms.your.spaces') : <spaceCopy.Copy k="other" />}
            actions={
              <>
                <Button tone="quiet" onClick={spaces.reload}>
                  <Text k="rooms.refresh" />
                </Button>
                <Button
                  tone="primary"
                  onClick={create}
                  disabled={heldAssets.length === 0}
                  aria-describedby={heldAssets.length === 0 ? 'spaces-create-why' : undefined}
                >
                  <Text k="rooms.create.space" />
                </Button>
              </>
            }
          >
            {heldAssets.length === 0 && held.resource.status === 'ready' && (
              <p id="spaces-create-why" className="lt-hint">
                {depthCopy.t('noAssets')}
              </p>
            )}
            {(context.status === 'none' || spaces.resource.status === 'ready') && (
              <ReadView resource={spaces.resource} reload={spaces.reload}>
                {(returned) => {
                  const rows = context.status === 'valid' ? returned.filter((row) => row.id !== context.id) : returned;
                  return (
                    <>
                      {rows.length ? (
                        <ul className="lt-rows">
                          {rows.map((space) => (
                            <li key={space.id}>
                              <article className="lt-stack">
                                <header className="lt-title-row">
                                  <div className="lt-lines">
                                    <h3>{space.name}</h3>
                                    <p className="lt-hint">
                                      {space.assetId} ·{' '}
                                      {space.kind === 'primary'
                                        ? copyText('rooms.primary.included.in.your.user.ledger.projection')
                                        : copyText('rooms.named.ledger.subaccount')}
                                    </p>
                                  </div>
                                  <strong className="lt-mono">{funds(space.balance, space.assetId)}</strong>
                                </header>
                                <dl className="lt-kv">
                                  <div>
                                    <dt>
                                      <Text k="rooms.target" />
                                    </dt>
                                    <dd>
                                      {space.goalTarget === null ? <spaceCopy.Copy k="noGoal" /> : funds(space.goalTarget, space.assetId)}
                                    </dd>
                                  </div>
                                  <div>
                                    <dt>
                                      <Text k="rooms.bank.lock" />
                                    </dt>
                                    <dd>{date(space.lockedUntil)}</dd>
                                  </div>
                                  <EarlyUnlock space={space} />
                                  <div>
                                    <dt>
                                      <Text k="rooms.space.reference" />
                                    </dt>
                                    <dd>
                                      <details>
                                        <summary>{spaceCopy.t('details')}</summary>
                                        <span lang="zxx">{space.id}</span>
                                      </details>
                                    </dd>
                                  </div>
                                </dl>
                                <GoalProgress balance={space.balance} target={space.goalTarget} assetId={space.assetId} />
                                <SpaceActions space={space} open={open} />
                              </article>
                            </li>
                          ))}
                        </ul>
                      ) : context.status === 'none' ? (
                        <NoRows title={copyText('rooms.no.spaces.returned')}>
                          <Text k="rooms.create.a.named.space.its.balance.will" />
                        </NoRows>
                      ) : (
                        <p className="lt-hint">
                          <spaceCopy.Copy k="noOther" />
                        </p>
                      )}
                      <Continuation count={returned.length} limit={limit} onMore={() => setLimit(Math.min(200, limit + 50))} />
                    </>
                  );
                }}
              </ReadView>
            )}
          </BankSection>
        </div>
      }
      sections={
        <div className="lt-body">
          {spaces.resource.status === 'ready' && <IncomeSorter spaces={spaces.resource.data} open={open} />}
          <InstantSavings open={open} />
          {spaces.resource.status === 'ready' && <SharedPots spaces={spaces.resource.data} open={open} />}
          <BankSection
            title={copyText('rooms.assets.without.a.space')}
            description={copyText('rooms.positive.user.available.accounts.only.these.quantities')}
          >
            <ReadView resource={unnamed.resource} reload={unnamed.reload}>
              {(rows) =>
                rows.length ? (
                  rows.map((row) => (
                    <div data-testid="money-space-row" className="lt-title-row" key={row.assetId}>
                      <strong>{row.assetId}</strong>
                      <span className="lt-mono">{funds(row.balance, row.assetId)}</span>
                    </div>
                  ))
                ) : (
                  <NoRows title={copyText('rooms.no.unnamed.positive.quantities.returned')}>
                    <Text k="rooms.this.does.not.establish.that.all.balances" />
                  </NoRows>
                )
              }
            </ReadView>
          </BankSection>
        </div>
      }
    />
  );
}

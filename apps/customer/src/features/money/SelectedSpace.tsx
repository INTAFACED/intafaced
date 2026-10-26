import type { ReactNode } from 'react';
import { Failure, Loading } from '../../shared/ui';
import type { Resource } from '../../shared/resource';
import type { Space } from './client';
import { funds } from './components';
import { stamp } from '../../screens/money/time';
import { Text } from './copy';
import { usePreferences } from '../../shared/preferences';
import { GoalProgress } from './GoalAndMovement';
import { EarlyUnlock } from './SpaceLock';
import { BillsPotState } from './BillsPot';
import { currentSpace, type SpaceContext } from './space-context';
import { spaceCopy } from './space-copy';

export function SelectedSpace({
  context,
  resource,
  owner,
  reload,
  actions,
  below,
}: {
  context: SpaceContext;
  resource: Resource<Space[]>;
  owner: string;
  reload: () => void;
  actions: (space: Space) => ReactNode;
  /** The rest of the space's own page, under its goal: what flows into it and its statement. */
  below?: (space: Space, all: Space[]) => ReactNode;
}) {
  const { Copy, t, languageFor, directionFor } = spaceCopy.useCopy();
  const { timeZone } = usePreferences();
  if (context.status === 'none') return null;
  const reference = context.status === 'valid' ? context.id : null;
  const space = reference && resource.status === 'ready' ? currentSpace(resource.data, reference, owner) : undefined;
  const refused =
    context.status === 'invalid'
      ? 'invalid'
      : resource.status === 'ready' && !space
        ? resource.data.some((row) => row.id === reference)
          ? 'conflict'
          : 'missing'
        : null;
  const quantity = space ? funds(space.balance, space.assetId) : '';
  return (
    <section
      data-testid="money-selected-space"
      className="money-selected-space"
      aria-label={t('selected')}
      lang={languageFor('selected')}
      dir={directionFor('selected')}
    >
      <header>
        <p className="money-selected-label">
          <Copy k="selected" />
        </p>
        {space && (
          <>
            <h2 lang="und" dir="auto">
              {space.name}
            </h2>
            <p className="money-caption">
              <Copy k={space.kind === 'primary' ? 'primary' : 'named'} />
            </p>
          </>
        )}
        {refused && (
          <>
            <h2>
              <Copy k={refused} />
            </h2>
            <p className="money-caption">
              <Copy k={`${refused}Note`} />
            </p>
          </>
        )}
      </header>
      {space ? (
        <>
          <div className="money-selected-quantity">
            <p>
              <Copy k="quantity" />
            </p>
            <strong className="numeric" lang="zxx" dir="ltr">
              {quantity.slice(0, -(space.assetId.length + 1))} <span lang="und">{space.assetId}</span>
            </strong>
          </div>
          <dl className="money-selected-details">
            <div className="money-selected-reference">
              <dt>
                <Text k="rooms.space.reference" />
              </dt>
              <dd>
                <details>
                  <summary>
                    <Copy k="details" />
                  </summary>
                  <span lang="zxx" dir="ltr">
                    {space.id}
                  </span>
                </details>
              </dd>
            </div>
            <div className="money-selected-lock">
              <dt>
                <Text k="rooms.bank.lock" />
              </dt>
              <dd>
                {space.lockedUntil && Number.isFinite(Date.parse(space.lockedUntil)) ? (
                  <time lang="en-GB" dir="auto" dateTime={space.lockedUntil}>
                    {stamp(space.lockedUntil, timeZone)}
                  </time>
                ) : space.lockedUntil ? (
                  <Text k="components.date.unavailable" />
                ) : (
                  <Copy k="noLock" />
                )}
              </dd>
              {space.lockedUntil && Date.parse(space.lockedUntil) > Date.now() && (
                <dd className="money-caption">
                  <Copy k="lockedNote" />
                </dd>
              )}
            </div>
            <EarlyUnlock space={space} />
            <BillsPotState space={space} />
          </dl>
          <div className="money-selected-actions">
            {actions(space)}
            <p className="money-caption">
              <Copy k="transferNote" />
            </p>
          </div>
          <dl className="money-selected-goal">
            <div>
              <dt>
                <Text k="rooms.target" />
              </dt>
              <dd>
                {space.goalTarget === null ? (
                  <Copy k="noGoal" />
                ) : (
                  <span lang="zxx" dir="ltr">
                    {funds(space.goalTarget, space.assetId)}
                  </span>
                )}
              </dd>
              <dd className="money-caption">
                <Copy k="goalNote" />
              </dd>
            </div>
          </dl>
          <GoalProgress balance={space.balance} target={space.goalTarget} assetId={space.assetId} />
          {below && resource.status === 'ready' && below(space, resource.data)}
        </>
      ) : (
        <>
          {reference && (
            <dl className="money-selected-details">
              <div>
                <dt>
                  <Text k="rooms.space.reference" />
                </dt>
                <dd>
                  <details>
                    <summary>
                      <Copy k="details" />
                    </summary>
                    <span lang="zxx" dir="ltr">
                      {reference}
                    </span>
                  </details>
                </dd>
              </div>
            </dl>
          )}
          {context.status === 'valid' && resource.status === 'loading' && <Loading />}
          {context.status === 'valid' && resource.status === 'failed' && <Failure result={resource.failure} retry={reload} />}
        </>
      )}
    </section>
  );
}

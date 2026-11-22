import { useLayoutEffect, useRef, useState } from 'react';
import { BANK_RAMPS_FIAT_SETTLE } from '@intafaced/contracts/bank-ramps-procedures';
import { BANK_RAMPS_PROGRAMME } from '@intafaced/contracts/bank-ramps-procedures';
import type { z } from 'zod';
import { Button, Segmented } from '@intafaced/ui/lit';
import { bankReads } from '../contracts';
import { funds, useBankRead, usePageLimit, useBankRecord } from '../components';
import { currentOwnerRecord, ReportedTime, useBankView } from '../bank-context';
import { Continuation, Panel, ResourceView } from '../bank-settings/parts';
import { railCopy } from '../rail-copy';
import { Text, t as copyText } from '../copy';

type Direction = 'in' | 'out';
type RailRecord = z.infer<(typeof bankReads)['ramps.onramps']>[number] | z.infer<(typeof bankReads)['ramps.offramps']>[number];

function Reference({ value }: { value: string }) {
  const { Copy } = railCopy.useCopy();
  return (
    <span lang="zxx" dir="ltr">
      {value || <Copy k="emptyValue" />}
    </span>
  );
}
function Quantity({ row }: { row: RailRecord }) {
  const { Copy } = railCopy.useCopy();
  return row.assetId.trim() ? (
    <span lang="zxx" dir="ltr">
      <strong>{funds(row.amount, '').trimEnd()}</strong> <span className="lt-hint">{row.assetId}</span>
    </span>
  ) : (
    <Copy k="assetUnavailable" />
  );
}
function Identity({ row }: { row: RailRecord }) {
  const { Copy } = railCopy.useCopy();
  return (
    <div>
      <h3>
        <Copy k={'railRef' in row ? 'incoming' : 'outgoing'} /> ·{' '}
        <bdi lang="und" dir="auto">
          {row.kind}
        </bdi>{' '}
        · <Copy k="status" />{' '}
        <bdi lang="und" dir="auto">
          {row.status || <Copy k="emptyValue" />}
        </bdi>
      </h3>
      <dl>
        <dt className="lt-sr">
          <Copy k="reference" />
        </dt>
        <dd>
          <Reference value={row.id} />
        </dd>
      </dl>
    </div>
  );
}
function RecordFacts({ row }: { row: RailRecord }) {
  const { Copy } = railCopy.useCopy();
  const refs: ['railReference' | 'ledger' | 'destination' | 'client' | 'hold' | 'settle', string | null][] =
    'railRef' in row
      ? [
          ['railReference', row.railRef],
          ['ledger', row.ledgerTxId],
        ]
      : [
          ['destination', row.destinationRef],
          ['client', row.clientRef],
          ['hold', row.holdLedgerTxId],
          ['settle', row.settleLedgerTxId],
        ];
  return (
    <article>
      <Identity row={row} />
      <Quantity row={row} />
      <dl className="lt-kv">
        <div>
          <dt>
            <Copy k="rail" />
          </dt>
          <dd lang="und" dir="auto">
            {row.rail || <Copy k="emptyValue" />}
          </dd>
        </div>
        <div>
          <dt>
            <Copy k="created" />
          </dt>
          <dd>
            <ReportedTime value={row.createdAt} />
          </dd>
        </div>
      </dl>
      <dl className="lt-kv">
        {refs.map(([label, value]) => (
          <div key={label}>
            <dt>
              <Copy k={label} />
            </dt>
            <dd>{value == null ? <Copy k="notReturned" /> : <Reference value={value} />}</dd>
          </div>
        ))}
      </dl>
      <div>
        {row.simulated && (
          <p className="lt-hint">
            <Copy k="simulated" />
          </p>
        )}
        {refs.some(([, value]) => value === null) && (
          <p className="lt-hint">
            <Copy k="absentTransaction" />
          </p>
        )}
        <p className="lt-hint">
          <Copy k="noDelivery" />
        </p>
      </div>
    </article>
  );
}

/** Current owner windows, not a receipt lookup or a complete history. Selection
 * retains only a reference in RAM; every fact comes from the current response. */
function RailWindow({ direction }: { direction: Direction }) {
  const { Copy, t, languageFor, directionFor } = railCopy.useCopy();
  const current = useBankView();
  const [limit, setLimit] = usePageLimit();
  const query = useBankRead(direction === 'in' ? 'ramps.onramps' : 'ramps.offramps', { limit });
  const [selected, setSelected] = useState<{ id: string; serial: number } | null>(null);
  const serial = useRef(0),
    heading = useRef<HTMLHeadingElement>(null),
    listHeading = useRef<HTMLSpanElement>(null);
  const rows: RailRecord[] = query.resource.status === 'ready' ? query.resource.data : [];
  const record = selected ? currentOwnerRecord(rows, selected.id) : undefined;
  const other = record ? rows.filter((row) => row !== record) : rows;
  const refresh = () => {
    if (current()) query.reload();
  };
  useLayoutEffect(() => {
    if (!current() || !serial.current || document.querySelector('[role="dialog"]')) return;
    const target = selected ? heading.current : listHeading.current;
    target?.focus({ preventScroll: true });
    target?.scrollIntoView({ block: 'start' });
  }, [selected?.serial]);
  return (
    <div lang={languageFor('recordsIn')} dir={directionFor('recordsIn')}>
      {selected && (
        <section aria-labelledby="money-selected-ramp-heading">
          <header>
            <h2 id="money-selected-ramp-heading" ref={heading} tabIndex={-1}>
              <Copy k="selected" />
            </h2>
            <Button
              tone="quiet"
              onClick={() => {
                if (current() && !document.querySelector('[role="dialog"]')) setSelected(null);
              }}
            >
              <Copy k="all" />
            </Button>
          </header>
          {!record && (
            <dl>
              <dt>
                <Copy k={direction === 'in' ? 'incoming' : 'outgoing'} /> · <Copy k="reference" />
              </dt>
              <dd>
                <Reference value={selected.id} />
              </dd>
            </dl>
          )}
          <ResourceView resource={query.resource} reload={refresh}>
            {() =>
              record ? (
                <RecordFacts row={record} />
              ) : (
                <div role="status">
                  <h3>
                    <Copy k={rows.some((row) => row.id.toLowerCase() === selected.id.toLowerCase()) ? 'conflict' : 'missing'} />
                  </h3>
                  <p>
                    <Copy k="missingNote" />
                  </p>
                  <Button tone="secondary" onClick={refresh}>
                    <Copy k="refresh" />
                  </Button>
                </div>
              )
            }
          </ResourceView>
        </section>
      )}
      <Panel
        title={
          <span id="money-ramp-list-heading" ref={listHeading} tabIndex={-1}>
            <Copy k={direction === 'in' ? (record ? 'otherIn' : 'recordsIn') : record ? 'otherOut' : 'recordsOut'} />
          </span>
        }
        actions={
          <Button tone="quiet" onClick={refresh} aria-label={t('refresh')}>
            <Copy k="refreshShort" />
          </Button>
        }
        lead={t('newest', { limit })}
      >
        <ResourceView resource={query.resource} reload={refresh}>
          {() => (
            <>
              {other.length ? (
                other.map((row, index) => (
                  <article key={`${row.id}:${index}`}>
                    <Identity row={row} />
                    <Quantity row={row} />
                    <div className="lt-toolbar">
                      <bdi lang="und" dir="auto">
                        {row.rail || <Copy k="emptyValue" />}
                      </bdi>
                      <ReportedTime value={row.createdAt} />
                      {row.simulated && <Text k="rooms.simulation.record" />}
                    </div>
                    <Button
                      tone="secondary"
                      aria-label={t('inspect', { reference: row.id })}
                      lang={languageFor('inspect')}
                      dir={directionFor('inspect')}
                      disabled={!currentOwnerRecord(rows, row.id)}
                      onClick={() => {
                        if (current() && currentOwnerRecord(rows, row.id) === row && !document.querySelector('[role="dialog"]'))
                          setSelected({ id: row.id, serial: ++serial.current });
                      }}
                    >
                      <Copy k="inspectShort" />
                    </Button>
                  </article>
                ))
              ) : (
                <div role="status">
                  <h3>
                    <Copy k={record ? 'noOther' : 'empty'} />
                  </h3>
                  <p>
                    <Copy k="emptyNote" />
                  </p>
                </div>
              )}
              <Continuation
                count={rows.length}
                limit={limit}
                onMore={() => {
                  if (current()) setLimit(Math.min(200, limit + 50));
                }}
              />
              <p className="lt-hint">
                <Copy k="window" />
              </p>
            </>
          )}
        </ResourceView>
      </Panel>
    </div>
  );
}
function ConnectionDetails() {
  const { Copy } = railCopy.useCopy();
  const current = useBankView();
  const programme = useBankRecord(BANK_RAMPS_PROGRAMME, undefined),
    fiat = useBankRecord(BANK_RAMPS_FIAT_SETTLE, undefined);
  return (
    <details>
      <summary>
        <Copy k="connections" />
      </summary>
      <Panel level={3} title={copyText('rooms.rail.programme')}>
        <ResourceView
          resource={programme.resource}
          reload={() => {
            if (current()) programme.reload();
          }}
        >
          {(info) => (
            <>
              <p lang="und" dir="auto">
                {info.displayName}
              </p>
              <p className="lt-hint">
                {info.simulated ? (
                  <Text k="rooms.this.programme.is.simulated.ledger.entries.do" />
                ) : (
                  <Text k="rooms.the.service.supplied.this.programme.identity" />
                )}
              </p>
              <dl className="lt-kv">
                <div>
                  <dt>
                    <Text k="rooms.crypto.rail" />
                  </dt>
                  <dd>{info.cryptoRail === null ? <Text k="rooms.not.connected" /> : <Reference value={info.cryptoRail} />}</dd>
                </div>
                <div>
                  <dt>
                    <Text k="rooms.fiat.adapter" />
                  </dt>
                  <dd>
                    <Reference value={info.fiatVia} />
                  </dd>
                </div>
              </dl>
            </>
          )}
        </ResourceView>
      </Panel>
      <Panel level={3} title={copyText('rooms.fiat.settlement.capability')}>
        <ResourceView
          resource={fiat.resource}
          reload={() => {
            if (current()) fiat.reload();
          }}
        >
          {(info) => (
            <p className="lt-hint">
              <Text k="rooms.the.adapter.can.settle.using" />
              <Reference value={info.onrampRailId} />
              <Text k="rooms.and" />
              <Reference value={info.offrampRailId} />
              <Text k="rooms.live.custody.delivery.and.programme.authority.still" />
            </p>
          )}
        </ResourceView>
      </Panel>
    </details>
  );
}
export function OwnerRailRecords() {
  const { Copy, t, languageFor, directionFor } = railCopy.useCopy();
  const current = useBankView();
  const [direction, setDirection] = useState<Direction>('in');
  return (
    <div lang={languageFor('direction')} dir={directionFor('direction')}>
      <div>
        <p className="lt-hint">
          <Copy k="fundingUnavailable" />
        </p>
        <div className="lt-actions">
          <a className="lt-link" href="/uc/recharge">
            <Copy k="depositShort" />
          </a>
          <a className="lt-link" href="/uc/withdraw">
            <Copy k="withdrawalShort" />
          </a>
        </div>
      </div>
      <Segmented
        label={t('direction')}
        value={direction}
        options={[
          { value: 'in', label: t('incoming') },
          { value: 'out', label: t('outgoing') },
        ]}
        onChange={(value) => {
          if (current() && !document.querySelector('[role="dialog"]')) setDirection(value);
        }}
      />
      <RailWindow key={direction} direction={direction} />
      <ConnectionDetails />
    </div>
  );
}

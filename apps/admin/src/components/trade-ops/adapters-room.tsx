import type { ReactNode } from 'react';
import { clockUtc } from '@/lib/trade-ops/markets-model';
import { sessionAccount, type AdapterHalf, type AdapterStatus } from '@/lib/trade-ops/adapters-model';

/**
 * FIX and SBE (J-cex-spot-20 #3): the FIX sessions, the CompID mapping and the SBE consumers, each exactly as the adapter
 * reported it. Each region carries its own read state; a refused or unread adapter says why, by code, and shows no rows.
 * The adapters carry orders and market data only, so no column here is a money or risk figure.
 */
function Region<T>({ title, half, children }: { title: string; half: AdapterHalf<T>; children: (data: T) => ReactNode }) {
  return (
    <section aria-label={title} data-read={half.read} className="flex flex-col gap-2 border-b border-line pbe-4">
      <h2 className="m-0 text-base font-medium text-fg">{title}</h2>
      {half.read === 'ok' ? (
        children(half.data)
      ) : (
        <p role="alert" className="m-0 text-sm text-warn">
          {half.read === 'unknown' ? 'No answer' : 'Refused'}: <code>{half.code}</code> {half.error}
          {half.key ? ` (${half.key})` : ''}
        </p>
      )}
    </section>
  );
}

const th = 'text-start font-normal';

export function AdaptersRoom({ status }: { status: AdapterStatus }) {
  return (
    <div className="flex flex-col gap-6" data-room="adapters">
      <Region title="FIX sessions" half={status.fix}>
        {(fix) => (
          <>
            <p className="m-0 text-xs text-fg-2">
              Read from svc-fix at {clockUtc(fix.asOf)}. Each session as the FIX engine holds it now; the account is the one its orders
              submit to matching as.
            </p>
            {fix.sessions.length === 0 ? (
              <p className="m-0 text-sm text-fg-2">svc-fix reports no FIX session.</p>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-fg-3">
                    <th className={th}>Session</th>
                    <th className={th}>Version</th>
                    <th className={th}>Our CompID</th>
                    <th className={th}>Counterparty CompID</th>
                    <th className={th}>State</th>
                    <th className={th}>Account</th>
                    <th className={th}>Next out seq</th>
                    <th className={th}>Next in seq</th>
                  </tr>
                </thead>
                <tbody>
                  {fix.sessions.map((s) => (
                    <tr key={`${s.role}:${s.senderCompId}:${s.targetCompId}`} data-session={`${s.senderCompId}:${s.targetCompId}`}>
                      <td>{s.role === 'order-entry' ? 'Order entry' : 'Drop copy'}</td>
                      <td className="if-num">{s.beginString}</td>
                      <td className="if-num break-all">{s.senderCompId}</td>
                      <td className="if-num break-all">{s.targetCompId}</td>
                      <td data-col="state">{s.state}</td>
                      <td className="if-num break-all" data-col="account">
                        {sessionAccount(s)}
                      </td>
                      <td className="if-num">{s.nextSenderSeq}</td>
                      <td className="if-num">{s.nextTargetSeq}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        )}
      </Region>

      <Region title="CompID mapping" half={status.fix}>
        {(fix) =>
          !fix.compIdMapSet ? (
            <p className="m-0 text-sm text-warn">
              <code>FIX_COMPID_ACCOUNT_JSON</code> is blank on svc-fix, so every FIX order refuses <code>matching_account_unmapped</code>.
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-fg-3">
                  <th className={th}>Counterparty CompID</th>
                  <th className={th}>Account</th>
                </tr>
              </thead>
              <tbody>
                {fix.compIdMap.map((m) => (
                  <tr key={m.compId} data-compid={m.compId}>
                    <td className="if-num break-all">{m.compId}</td>
                    <td className="if-num break-all" data-col="account">
                      {m.accountId}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        }
      </Region>

      <Region title="SBE consumers" half={status.sbe}>
        {(sbe) => (
          <>
            <p className="m-0 text-xs text-fg-2" data-codec={sbe.codecLinked ? 'linked' : 'unlinked'}>
              Read from svc-ws at {clockUtc(sbe.asOf)}.{' '}
              {sbe.codecLinked
                ? 'The SBE codec is linked: each open SBE depth socket is listed with the last tape sequence it was sent.'
                : 'The SBE codec is not linked on this svc-ws, so an SBE subscription refuses depth.sbe_unavailable and none can be open.'}
            </p>
            {sbe.consumers.length === 0 ? (
              <p className="m-0 text-sm text-fg-2">svc-ws reports no open SBE consumer.</p>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-fg-3">
                    <th className={th}>Consumer</th>
                    <th className={th}>Market</th>
                    <th className={th}>Connected (UTC)</th>
                    <th className={th}>Frames sent</th>
                    <th className={th}>Last sequence</th>
                  </tr>
                </thead>
                <tbody>
                  {sbe.consumers.map((c) => (
                    <tr key={c.id} data-consumer={c.id}>
                      <td className="if-num">{c.id}</td>
                      <td className="if-num">{c.marketId}</td>
                      <td className="if-num">{clockUtc(c.connectedAt)}</td>
                      <td className="if-num">{c.framesSent}</td>
                      <td className="if-num" data-col="last-sequence">
                        {c.lastSequence ?? 'None sent'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        )}
      </Region>
    </div>
  );
}

import { useState } from 'react';
import { Button, Tag } from '@intafaced/ui/lit';
import { SelectField } from '@intafaced/ui/lit/templates';
import { SUPPORT_GRANT_READ, SUPPORT_READ_ACCESS, type SupportReadGrant } from '@intafaced/contracts/support-read-grants';
import { usePreferences } from '../../shared/preferences';
import { useResource } from '../../shared/resource';
import { stamp } from '../../screens/money/time';
import { useApi, useSession } from '../session';
import { deskCopy } from './support-desk-copy';
import { ticketReference } from './support-desk';
import { plainSupportResult } from './support-refusal';
import type { Ticket } from './support-schemas';
import { KitDetails, type KitAction } from './volt-action';
import { EmptyNote, KitRead, ScrollTable } from './volt-parts';

/** The lengths a customer picks from, in seconds, each inside the service's own bounds (half a minute to one week). */
const READ_GRANT_LENGTHS = [
  ['900', 'readAccessLength900'],
  ['3600', 'readAccessLength3600'],
  ['86400', 'readAccessLength86400'],
  ['604800', 'readAccessLength604800'],
] as const;

const KIND_KEY = { balance: 'readAccessKindBalance', destination: 'readAccessKindDestination', fills: 'readAccessKindFills' } as const;

/** What the grant line says: never given, still holding, or ended. Judged on the service's clock when it answered. */
const grantState = (grant: SupportReadGrant | null): 'none' | 'active' | 'ended' => (!grant ? 'none' : grant.active ? 'active' : 'ended');

/**
 * Support's access to this request's customer's balance and withdrawal details (J-support-public-20 #2): the team reads
 * neither until the customer allows it here for a length of time they pick, and each read the team was answered is
 * listed here: what was read, who read it and when. A closed request takes no new permission and opens no read.
 * The parent mounts this only inside a verified exact-owner ticket read.
 */
export function SupportReadAccess({ ticket, action }: { ticket: Ticket; action: KitAction }) {
  const copy = deskCopy.useCopy();
  const api = useApi(),
    { userId } = useSession(),
    { timeZone } = usePreferences();
  const id = ticket.id;
  const [length, setLength] = useState<string>(READ_GRANT_LENGTHS[0][0]);
  const access = useResource(
    (signal) => api.call(SUPPORT_READ_ACCESS, { ticketId: id }, { signal, accept: (row) => row.ticketId === id }),
    `support-read-access:${userId}:${id}`,
  );
  const lengthKey = READ_GRANT_LENGTHS.find(([seconds]) => seconds === length)?.[1] ?? READ_GRANT_LENGTHS[0][1];
  const open = ticket.status !== 'closed';
  return (
    <section className="lt-stack" aria-label={copy.t('readAccessHeading')} data-testid="support-read-access">
      <div className="lt-actions">
        <h3>{copy.t('readAccessHeading')}</h3>
        <Button tone="secondary" onClick={access.reload}>
          {copy.t('readAccessRefresh')}
        </Button>
      </div>
      <p className="lt-hint">{copy.t('readAccessIntro')}</p>
      <KitRead resource={access.resource} retry={access.reload}>
        {(row) => {
          const state = grantState(row.grant);
          return (
            <>
              <p data-testid="support-read-grant" data-state={state} data-expires-at={row.grant?.expiresAt ?? ''}>
                <Tag tone={state === 'active' ? 'accent' : 'neutral'}>{copy.t(state === 'active' ? 'readAccessOn' : 'readAccessOff')}</Tag>{' '}
                {row.grant
                  ? copy.t(state === 'active' ? 'readAccessActive' : 'readAccessEnded', {
                      until: stamp(row.grant.expiresAt, timeZone, Date.now(), true),
                    })
                  : copy.t('readAccessNone')}
              </p>
              <h4>{copy.t('readAccessReadsHeading')}</h4>
              {row.reads.length === 0 ? (
                <EmptyNote title={copy.t('readAccessNoReads')}>{copy.t('readAccessNoReadsBody')}</EmptyNote>
              ) : (
                <ScrollTable
                  label={copy.t('readAccessReadsHeading')}
                  headers={[copy.t('readAccessWhat'), copy.t('readAccessWho'), copy.t('readAccessWhen')]}
                >
                  {row.reads.map((read, index) => (
                    <tr key={`${read.readAt}:${index}`} data-testid="support-read-row" data-kind={read.kind} data-read-by={read.readBy}>
                      <td>{copy.t(KIND_KEY[read.kind])}</td>
                      <td>
                        {copy.t('readAccessAgent')} <span lang="zxx">{read.readBy}</span>
                      </td>
                      <td>
                        <time dateTime={read.readAt} lang="zxx">
                          {stamp(read.readAt, timeZone, Date.now(), true)}
                        </time>
                      </td>
                    </tr>
                  ))}
                </ScrollTable>
              )}
            </>
          );
        }}
      </KitRead>
      {open ? (
        <div className="lt-stack">
          <SelectField
            label={copy.t('readAccessLength')}
            value={length}
            onChange={setLength}
            options={READ_GRANT_LENGTHS.map(([value, key]) => ({ value, label: copy.t(key) }))}
            hint={copy.t('readAccessReplaces')}
          />
          <Button
            tone="primary"
            disabled={action.disabled}
            onClick={() =>
              action.stage({
                title: () => deskCopy.t('readAccessTitle'),
                reference: id,
                confirm: () => deskCopy.t('readAccessConfirm'),
                success: () => deskCopy.t('readAccessDone'),
                content: () => (
                  <KitDetails
                    items={[
                      [deskCopy.t('reference'), <span lang="zxx">{ticketReference(id)}</span>],
                      [deskCopy.t('subjectField'), <span lang="und">{ticket.subject}</span>],
                      [deskCopy.t('readAccessLength'), deskCopy.t(lengthKey)],
                    ]}
                  />
                ),
                run: async () =>
                  plainSupportResult(
                    await api.call(
                      SUPPORT_GRANT_READ,
                      { ticketId: id, seconds: Number(length) },
                      { accept: (grant) => grant.ticketId === id && grant.active },
                    ),
                    { 'support.ticket_closed': 'refuseGrantClosed' },
                  ),
                done: access.reload,
              })
            }
          >
            {copy.t('readAccessReview')}
          </Button>
        </div>
      ) : (
        <p className="lt-hint">{copy.t('readAccessClosed')}</p>
      )}
    </section>
  );
}

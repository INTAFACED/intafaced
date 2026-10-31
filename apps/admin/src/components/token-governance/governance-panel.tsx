'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ControlDesk, type ControlAction } from '@/components/control-desk';
import { formatAsOf, formatWhen } from '@/lib/as-of';
import type { Part } from '@/lib/desk/part';
import {
  GOVERNANCE_ROLES,
  ROLE_USER,
  ROLE_WORDS,
  durationWords,
  hoursToMs,
  msToHours,
  type GovernanceRole,
} from '@/lib/token-governance/model';
import type { GovernanceRead } from '@/lib/token-governance/server';
import '@/components/desk.css';

/**
 * Token governance (J-more-catalogue-10). The voting delay and period a proposal takes when it gives no time of its own, and
 * who holds a governance role, as svc-token holds them. Every change needs two founders: one asks, the other approves the
 * same packet on their own console, then the first runs it. Moderators cancel proposals in the customer governance room.
 */

function Failed({ part }: { part: Extract<Part<unknown>, { kind: 'failed' }> }) {
  return (
    <p role="alert" className="dk-muted">
      {part.message}
      {part.code ? ` (${part.code})` : ''}
    </p>
  );
}

const ROLE_LABEL: Record<GovernanceRole, string> = { controller: 'Controller', admin: 'Admin', moderator: 'Moderator', author: 'Author' };

export function GovernancePanel({ read, userId }: { read: GovernanceRead; userId: string }) {
  const router = useRouter();
  const refresh = () => router.refresh();
  const settings = read.settings.kind === 'ok' ? read.settings.data : null;
  const roles = read.roles.kind === 'ok' ? read.roles.data : [];

  // Settings: hours in the form, milliseconds in the request. Blank is "not set", so the form starts from what is stored:
  // changing one figure never clears the other.
  const [delay, setDelay] = useState(() => msToHours(settings?.votingDelayMs ?? null));
  const [period, setPeriod] = useState(() => msToHours(settings?.votingPeriodMs ?? null));
  const d = hoursToMs(delay, 'delay');
  const p = hoursToMs(period, 'period');
  const settingsHold = !d.ok ? d.why : !p.ok ? p.why : null;
  const settingsAction: ControlAction = {
    heading: 'Change the voting delay and period',
    submitLabel: 'Ask a second founder to approve these settings',
    needsReason: false,
    reasonLabel: '',
    build: () => ({
      kind: 'token.governance.settings.set',
      votingDelayMs: d.ok ? (d.ms ?? '') : '',
      votingPeriodMs: p.ok ? (p.ms ?? '') : '',
      revision: String(settings?.revision ?? 0),
    }),
  };

  // Roles: one account at a time; an account never in the list starts at revision 0.
  const [account, setAccount] = useState('');
  const [role, setRole] = useState('');
  const target = account.trim();
  const current = roles.find((r) => r.userId === target) ?? null;
  const roleHold = !ROLE_USER.test(target)
    ? 'Enter the account id.'
    : !current && read.rolesFull
      ? `Only the first ${roles.length} accounts with a role were read, and this one is not among them, so its role revision is not known here.`
      : role === ''
        ? 'Choose a role.'
        : role === 'none' && !current?.role
          ? 'This account has no role to remove.'
          : (current?.role ?? 'none') === role
            ? 'The account already has that role.'
            : null;
  const roleAction: ControlAction = {
    heading: 'Change a governance role',
    submitLabel: 'Ask a second founder to approve this role change',
    needsReason: false,
    reasonLabel: '',
    build: () => ({
      kind: 'token.governance.role.set',
      userId: ROLE_USER.test(target) ? target : 'x',
      role: role === 'none' || role === '' ? '' : (role as GovernanceRole),
      revision: String(current?.revision ?? 0),
    }),
  };

  return (
    <div className="dk" data-testid="token-governance">
      <div className="adm-pagehead">
        <div>
          <h1>Token governance</h1>
          <p>The voting delay and period, and who may cancel a proposal. Every change needs two founders.</p>
        </div>
      </div>
      <div className="dk-row">
        <button type="button" className="adm-btn" onClick={refresh}>
          Refresh
        </button>
        <span className="dk-asof">As of {formatAsOf(read.asOf)} (when this console read svc-token)</span>
      </div>

      <section className="dk-stack" aria-labelledby="gov-settings-h">
        <h2 id="gov-settings-h">Voting delay and period</h2>
        {read.settings.kind === 'failed' ? (
          <Failed part={read.settings} />
        ) : (
          <dl className="dk-kv" data-testid="governance-settings">
            <dt>Voting delay</dt>
            <dd data-testid="voting-delay">{settings?.votingDelayMs ? durationWords(settings.votingDelayMs) : 'delay not set'}</dd>
            <dt>Voting period</dt>
            <dd data-testid="voting-period">{settings?.votingPeriodMs ? durationWords(settings.votingPeriodMs) : 'period not set'}</dd>
            <dt>Revision</dt>
            <dd>{settings?.revision}</dd>
          </dl>
        )}
        {settings && (settings.votingDelayMs === null || settings.votingPeriodMs === null) && (
          <p className="dk-muted" role="note">
            While a figure is not set, svc-token refuses a proposal that does not give that time itself (token.proposal_window_unset).
          </p>
        )}
        {read.history.kind === 'failed' ? (
          <Failed part={read.history} />
        ) : read.history.data.length === 0 ? (
          <p className="dk-muted">No change has been written yet.</p>
        ) : (
          <table className="adm-table" aria-label="Settings changes">
            <thead>
              <tr>
                <th scope="col">Change</th>
                <th scope="col">Delay</th>
                <th scope="col">Period</th>
                <th scope="col">Asked by</th>
                <th scope="col">Approved by</th>
                <th scope="col">When</th>
              </tr>
            </thead>
            <tbody>
              {read.history.data.map((m) => (
                <tr key={m.ordinal} data-testid="settings-move">
                  <td>{m.ordinal}</td>
                  <td>{durationWords(m.votingDelayMs)}</td>
                  <td>{durationWords(m.votingPeriodMs)}</td>
                  <td>
                    <code>{m.actorId}</code>
                  </td>
                  <td>
                    <code>{m.approverId}</code>
                  </td>
                  <td>{formatWhen(m.at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="dk-row">
          <label>
            Voting delay (hours, blank for not set)
            <input inputMode="numeric" value={delay} onChange={(e) => setDelay(e.target.value)} />
          </label>
          <label>
            Voting period (hours, blank for not set)
            <input inputMode="numeric" value={period} onChange={(e) => setPeriod(e.target.value)} />
          </label>
        </div>
        <ControlDesk
          key="governance-settings"
          endpoint="/api/more-ops/token-governance"
          userId={userId}
          blockedReason={read.settings.kind === 'failed' ? 'The settings cannot be read, so they cannot be changed.' : null}
          formHold={settingsHold}
          action={settingsAction}
          consequence="svc-token applies the change only if the settings are still at the revision read, and records who asked and who approved. Proposals already made keep their times."
          blockedButtonLabel="Settings changes unavailable"
          onChanged={refresh}
        />
      </section>

      <section className="dk-stack" aria-labelledby="gov-roles-h">
        <h2 id="gov-roles-h">Governance roles</h2>
        {read.rolesFull && (
          <p className="dk-muted" role="note">
            Only the first {roles.length} accounts are listed here; more exist.
          </p>
        )}
        {read.roles.kind === 'failed' ? (
          <Failed part={read.roles} />
        ) : roles.length === 0 ? (
          <p className="dk-muted">No account holds a governance role.</p>
        ) : (
          <table className="adm-table" aria-label="Governance roles">
            <thead>
              <tr>
                <th scope="col">Account</th>
                <th scope="col">Role</th>
                <th scope="col">Revision</th>
              </tr>
            </thead>
            <tbody>
              {roles.map((r) => (
                <tr key={r.userId} data-role-user={r.userId}>
                  <td>
                    <code>{r.userId}</code>
                  </td>
                  <td data-testid="role">{r.role ? ROLE_LABEL[r.role] : 'No role'}</td>
                  <td>{r.revision}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="dk-row">
          <label>
            Account id
            <input value={account} onChange={(e) => setAccount(e.target.value)} />
          </label>
          <label>
            Role
            <select value={role} onChange={(e) => setRole(e.target.value)}>
              <option value="">Choose</option>
              {GOVERNANCE_ROLES.map((r) => (
                <option key={r} value={r}>
                  {ROLE_WORDS[r]}
                </option>
              ))}
              <option value="none">No role (remove it)</option>
            </select>
          </label>
        </div>
        <ControlDesk
          key="governance-role"
          endpoint="/api/more-ops/token-governance"
          userId={userId}
          blockedReason={read.roles.kind === 'failed' ? 'The roles cannot be read, so none can be changed.' : null}
          formHold={roleHold}
          action={roleAction}
          consequence="svc-token applies the change only if the account's role is still at the revision read, and refuses it when a founder on this request is that account."
          blockedButtonLabel="Role changes unavailable"
          stepUpNote="A role change also needs a fresh step-up by the founder who runs it: svc-token refuses the run without this code, and the code works once, for this change only."
          onChanged={refresh}
        />
      </section>
    </div>
  );
}

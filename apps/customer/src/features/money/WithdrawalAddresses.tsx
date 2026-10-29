import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Button, EmptyState, Failure, Loading, Page } from '../../shared/ui';
import type { Resource } from '../../shared/resource';
import { useSession } from '../session/session';
import { date, useBankRead, type ActionSpec } from './components';
import {
  approvalMailAskedSchema,
  destinationCheckSchema,
  destinationReadinessSchema,
  destinationRemovedSchema,
  destinationSchema,
  type Destination,
  type DestinationCheck,
  type DestinationReadiness,
  type WithdrawAsset,
  walletProofStartedSchema,
  walletProofVerifiedSchema,
} from './contracts';
import { moneyRefusalWords } from './money-refusal-copy';
import { DepthPanel } from './DepthParts';
import { WithdrawStepUp } from './WithdrawStepUp';
import { SAVED_STATE_WORDS, checkAddress, checkLabel, checkTag, coolingOf, shortenAddress, shownState } from './withdraw-model';
import { withdrawalCopy } from './withdrawal-copy';
import './bank-depth.css';

const OWNERSHIP_KEYS = { pending: 'aOwnPending', expired: 'aOwnExpired' } as const;

/** Whether a row can be proved by signing: a wallet address the customer saved, still in the book. */
const provable = (row: Destination) => row.kind === 'crypto' && row.origin === 'customer' && row.state !== 'archived';

/**
 * The address book as a table. The columns always show; with no rows the body says why it is empty. Each row gives a short
 * form of the address and a Details control that opens the full address, so a long address never breaks the row. Every
 * cell comes from the bank's saved-destination read: a label (when one was set), the kind, the address, when it was added
 * the asset, network and tag, and the cooling-off the bank returned. An entry the bank calls active is shown as cooling off
 * while its cooling-off has not ended, and as blocked while no cooling-off is published, so the status never says "ready"
 * before it is.
 */
export function AddressTable({
  rows,
  now = Date.now(),
  onRename,
  onRemove,
  onProve,
  onUse,
}: {
  rows: readonly Destination[];
  now?: number;
  onRename?: (row: Destination) => void;
  onRemove?: (row: Destination) => void;
  onProve?: (row: Destination) => void;
  onUse?: (row: Destination) => void;
}) {
  const { t } = withdrawalCopy.useCopy();
  return (
    <>
      <div className="withdrawal-address-scroll">
        <table className="bd-table" data-testid="address-table">
          <thead>
            <tr>
              <th scope="col">{t('aColLabel')}</th>
              <th scope="col">{t('aColKind')}</th>
              <th scope="col">{t('aColNetwork')}</th>
              <th scope="col">{t('aColAddress')}</th>
              <th scope="col">{t('aColAdded')}</th>
              <th scope="col">{t('aColCooling')}</th>
              <th scope="col">{t('aColState')}</th>
              <th scope="col">{t('aColDetails')}</th>
            </tr>
          </thead>
          {rows.length > 0 && (
            <tbody>
              {rows.map((row) => {
                const cooling = coolingOf(row, now);
                return (
                  <tr key={row.destinationId}>
                    <td>
                      <span lang={row.label ? 'und' : undefined}>{row.label ?? t('aNoLabel')}</span>
                      {row.lookalikeConfirmedAt && (
                        <>
                          <br />
                          <small>{t('aLookalikeChecked', { time: date(row.lookalikeConfirmedAt) })}</small>
                        </>
                      )}
                      {row.ownership && row.ownership.state !== 'none' && (
                        <>
                          <br />
                          <small data-testid="address-ownership">
                            {row.ownership.state === 'verified'
                              ? t('aOwnVerified', { time: date(row.ownership.validUntil ?? '') })
                              : t(OWNERSHIP_KEYS[row.ownership.state])}
                          </small>
                        </>
                      )}
                    </td>
                    <td>{row.kind === 'bank' ? t('aKindBank') : t('aKindCrypto')}</td>
                    <td lang="und">
                      {row.assetId || row.network
                        ? [row.assetId, row.network, row.tag].filter((part) => part).join(' · ')
                        : t('aNotReturned')}
                    </td>
                    <td className="numeric" lang="und" data-withdrawal-private>
                      {shortenAddress(row.ref)}
                    </td>
                    <td>{date(row.addedAt)}</td>
                    <td>
                      {row.state === 'pending'
                        ? t('aCoolingAfterApproval')
                        : cooling.state === 'unset'
                          ? t('aCoolingUnset')
                          : t(cooling.state === 'ends' ? 'aCoolingEnds' : 'aCoolingEnded', { time: date(cooling.at) })}
                    </td>
                    <td>{row.state ? t(SAVED_STATE_WORDS[shownState(row.state, cooling.state)]) : t('aNotReturned')}</td>
                    <td>
                      {onUse && provable(row) ? (
                        <Button variant="ghost" onClick={() => onUse(row)}>
                          {t('aUse')}
                        </Button>
                      ) : null}
                      {onRename && row.state !== 'archived' ? (
                        <Button variant="ghost" onClick={() => onRename(row)}>
                          {t('aRename')}
                        </Button>
                      ) : null}
                      {onProve && provable(row) && row.ownership?.state !== 'verified' ? (
                        <Button variant="ghost" onClick={() => onProve(row)}>
                          {t('aProve')}
                        </Button>
                      ) : null}
                      {onRemove && row.state !== 'archived' ? (
                        <Button variant="ghost" onClick={() => onRemove(row)}>
                          {t('aRemove')}
                        </Button>
                      ) : null}
                      <details>
                        <summary>{t('aDetails')}</summary>
                        <p>
                          {t('aFullAddress')}:{' '}
                          <span lang="und" data-withdrawal-private className="withdrawal-address-full">
                            {row.ref}
                          </span>
                        </p>
                      </details>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          )}
        </table>
      </div>
      {rows.length === 0 && <EmptyState title={t('aEmptyTitle')}>{t('aEmptyBody')}</EmptyState>}
    </>
  );
}

/** The saved-destination read in its three states. A refusal goes through the shared refusal copy; no row is invented. */
export function AddressBook({
  resource,
  reload,
  now,
  onRename,
  onRemove,
  onProve,
  onUse,
}: {
  resource: Resource<readonly Destination[]>;
  reload: () => void;
  now?: number;
  onRename?: (row: Destination) => void;
  onRemove?: (row: Destination) => void;
  onProve?: (row: Destination) => void;
  onUse?: (row: Destination) => void;
}) {
  if (resource.status === 'loading') return <Loading />;
  if (resource.status === 'failed') return <Failure result={resource.failure} retry={reload} />;
  return <AddressTable rows={resource.data} now={now} onRename={onRename} onRemove={onRemove} onProve={onProve} onUse={onUse} />;
}

/** The bank's refusals for the security lock (W-withdraw-09), which have plain words of their own. */
const lockRefusal = (code: string | undefined) =>
  code === 'bank.security_locked' || code === 'bank.security_lock_unavailable' || code === 'bank.security_lock_unset';

/** The answer to "can money be sent to this address now?" in the customer's words, first reason first. */
export function readinessWords(
  answer: DestinationReadiness,
  label: string,
  t: ReturnType<typeof withdrawalCopy.useCopy>['t'],
): { text: string; locked: boolean } {
  switch (answer.state) {
    case 'ready':
      return { text: t('aUseReady', { label }), locked: false };
    case 'cooling':
      return {
        text: answer.coolingOffEndsAt ? t('aUseCooling', { label, time: date(answer.coolingOffEndsAt) }) : t('aUseCoolingNoEnd', { label }),
        locked: false,
      };
    case 'cooling_unset':
      return { text: t('aUseCoolingUnset', { label }), locked: false };
    case 'blocked':
      return { text: t('aUseBlocked', { label }), locked: false };
    case 'approval_pending':
      return { text: t('aUseApproval', { label }), locked: false };
    case 'locked':
      return {
        text: `${t('aUseLocked')} ${answer.lockUnlocksAt ? t('aUseLockEnds', { time: date(answer.lockUnlocksAt) }) : t('aUseLockAsk')}`,
        locked: true,
      };
  }
}

/**
 * "Withdraw to this address" (W-withdraw-09): the bank says whether money may be sent to this saved address now
 * (`ramps.destinations.readiness`), with the lock and cooling-off rules its send path applies. A new address is refused
 * with the time its cooling-off ends and a locked account with the lock. Nothing is sent from here.
 */
export function UseAddress({ row, onClose, onApproved }: { row: Destination; onClose: () => void; onApproved?: () => void }) {
  const { t } = withdrawalCopy.useCopy();
  const { api } = useSession();
  const [answer, setAnswer] = useState<DestinationReadiness | null>(null);
  // The refusal's code, or '' when the bank gave none; worded at render, in the language shown then.
  const [failed, setFailed] = useState<string | null>(null);
  // Approved here: the waiting answer no longer stands, and the approval says what happens next.
  const [approvedHere, setApprovedHere] = useState(false);
  useEffect(() => {
    let live = true;
    api
      .query('bank', 'ramps.destinations.readiness', { destinationId: row.destinationId }, destinationReadinessSchema)
      .then((result) => {
        if (!live) return;
        if (result.ok) setAnswer(result.data);
        else setFailed(result.code ?? '');
      })
      .catch(() => {
        if (live) setFailed('');
      });
    return () => {
      live = false;
    };
  }, [api, row.destinationId]);
  const problem = failed === null ? null : (moneyRefusalWords(failed) ?? t('aUseFailed'));
  const words = answer ? readinessWords(answer, row.label ?? shortenAddress(row.ref), t) : null;
  return (
    <div className="bd-stack" data-testid="address-use">
      {!answer && !problem && <p role="status">{t('aUseChecking')}</p>}
      {words && !approvedHere && <p role={answer?.state === 'ready' ? 'status' : 'alert'}>{words.text}</p>}
      {problem && <p role="alert">{problem}</p>}
      {answer?.state === 'approval_pending' && (
        <>
          <ApproveHere
            row={row}
            onApproved={() => {
              setApprovedHere(true);
              onApproved?.();
            }}
          />
          {!approvedHere && <ApprovalMail destinationId={row.destinationId} openUntil={answer.approvalLinkExpiresAt ?? null} />}
        </>
      )}
      <p>
        {words?.locked && (
          <a className="button button--secondary" href="/uc/safe">
            {t('aUseSecurity')}
          </a>
        )}
        <Button variant="ghost" onClick={onClose}>
          {t('aUseClose')}
        </Button>
      </p>
    </div>
  );
}

/** The bank's refusals of approving on this device, in the customer's words. */
function approveHereWords(code: string | undefined, t: ReturnType<typeof withdrawalCopy.useCopy>['t']): string {
  switch (code) {
    case 'bank.address_approval_same_device':
      return t('aApproveHereSame');
    case 'bank.address_approval_device_unknown':
      return t('aApproveHereUnknown');
    case 'bank.address_approval_device_untrusted':
      return t('aApproveHereUntrusted');
    case 'bank.address_approval_device_unavailable':
      return t('aApproveHereUnavailable');
    case 'bank.address_approval_not_pending':
      return t('aApprovalNotPending');
    default:
      return moneyRefusalWords(code) ?? t('aApproveHereFailed');
  }
}

/**
 * "Approve on this device" (W-withdraw-09): approves a waiting address from a signed-in device that did not save it,
 * after a fresh confirmation. The bank tells the devices apart from the access tokens, never from anything sent here, and
 * refuses the device that saved it, saying where to approve instead.
 */
export function ApproveHere({ row, onApproved }: { row: Destination; onApproved?: () => void }) {
  const { t } = withdrawalCopy.useCopy();
  const { api } = useSession();
  const [confirming, setConfirming] = useState(false);
  const [done, setDone] = useState<Destination | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  const answered = useRef<Destination | null>(null);
  const label = row.label ?? shortenAddress(row.ref);
  if (done) {
    return (
      <div className="bd-stack" data-testid="address-approve-here">
        <p role="status">
          {done.coolingOffEndsAt ? t('apDone', { label, time: date(done.coolingOffEndsAt) }) : t('apDoneNoTime', { label })}
        </p>
      </div>
    );
  }
  return (
    <div className="bd-stack" data-testid="address-approve-here">
      {refused && <p role="alert">{refused}</p>}
      <p>
        <Button
          variant="primary"
          onClick={() => {
            setRefused(null);
            setConfirming(true);
          }}
        >
          {t('aApproveHere')}
        </Button>
      </p>
      {confirming && (
        <WithdrawStepUp
          why={t('aApproveWhy')}
          run={async (bearer) => {
            const answer = await api.mutate(
              'bank',
              'ramps.destinations.approval.onDevice',
              { destinationId: row.destinationId },
              destinationSchema,
              { bearer },
            );
            if (answer.ok) {
              answered.current = answer.data;
              return answer;
            }
            if (
              answer.code === 'bank.address_approval_same_device' ||
              answer.code === 'bank.address_approval_device_unknown' ||
              answer.code === 'bank.address_approval_device_untrusted'
            ) {
              // Nothing the person can fix in this dialog: it closes and the panel says where to approve instead.
              setRefused(approveHereWords(answer.code, t));
              setConfirming(false);
            }
            return { ...answer, message: approveHereWords(answer.code, t) };
          }}
          onDone={() => {
            setConfirming(false);
            setDone(answered.current);
            onApproved?.();
          }}
          onCancel={() => setConfirming(false)}
        />
      )}
    </div>
  );
}

/** The bank's refusals of an approval-link request, in the customer's words. */
function approvalMailWords(code: string | undefined, t: ReturnType<typeof withdrawalCopy.useCopy>['t']): string {
  switch (code) {
    case 'bank.address_approval_email_unproved':
      return t('aApprovalMailUnproved');
    case 'bank.address_approval_mail_unavailable':
      return t('aApprovalMailOff');
    case 'bank.address_approval_link_unset':
      return t('aApprovalLinkUnset');
    case 'bank.address_approval_not_pending':
      return t('aApprovalNotPending');
    default:
      return moneyRefusalWords(code) ?? t('aApprovalMailFailed');
  }
}

/**
 * "Email me an approval link" (W-withdraw-09): the bank asks identity to mail a single-use link to the email address on
 * the account. The answer says the link was asked for and until when it works, never that it arrived. Asking again
 * replaces the open link, so only the newest email works.
 */
export function ApprovalMail({ destinationId, openUntil }: { destinationId: string; openUntil: string | null }) {
  const { t } = withdrawalCopy.useCopy();
  const { api } = useSession();
  const [busy, setBusy] = useState(false);
  const [asked, setAsked] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const until = asked ?? openUntil;
  async function ask() {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    try {
      const answer = await api.mutate('bank', 'ramps.destinations.approval.requestMail', { destinationId }, approvalMailAskedSchema);
      if (answer.ok) setAsked(answer.data.expiresAt);
      else setProblem(approvalMailWords(answer.code, t));
    } catch {
      setProblem(t('aApprovalMailFailed'));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="bd-stack" data-testid="address-approval-mail">
      {until && (
        <p role="status">{asked ? t('aApprovalMailAsked', { time: date(asked) }) : t('aUseApprovalOpen', { time: date(until) })}</p>
      )}
      {problem && <p role="alert">{problem}</p>}
      <p>
        <Button variant="secondary" onClick={() => void ask()} disabled={busy}>
          {until ? t('aApprovalMailAgain') : t('aApprovalMail')}
        </Button>
      </p>
    </div>
  );
}

type ProofOffer = { proofId: string; message: string; expiresAt: string };

/**
 * Prove a saved wallet by signing (W-withdraw-17). Opening it asks the bank for a message naming the address; the
 * customer signs it in that wallet and pastes the signature, and the bank checks which address signed. `bank:write`
 * only: signing proves control of the wallet, and nothing here changes where money goes. A wrong wallet, a lapsed
 * message or text that is not a signature is refused in the customer's words, and the message stays to sign again.
 */
export function ProveOwnership({ row, onProved, onClose }: { row: Destination; onProved: () => void; onClose: () => void }) {
  const { t } = withdrawalCopy.useCopy();
  const { api } = useSession();
  const [offer, setOffer] = useState<ProofOffer | null>(null);
  const [signature, setSignature] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [provedUntil, setProvedUntil] = useState<string | null>(null);
  // One offer per opening, also when a development render mounts the panel twice.
  const asked = useRef(false);
  const address = shortenAddress(row.ref);
  const words = (code: string | undefined) => {
    switch (code) {
      case 'bank.wallet_proof_wrong_signer':
        return t('aProveWrongSigner', { address });
      case 'bank.wallet_proof_signature_invalid':
        return t('aProveBadSignature');
      case 'bank.wallet_proof_expired':
        return t('aProveLapsed');
      case 'bank.wallet_proof_not_found':
        return t('aProveNotFound');
      case 'bank.wallet_proof_window_unset':
      case 'bank.wallet_proof_validity_unset':
        return t('aProveUnset');
      default:
        return moneyRefusalWords(code) ?? t('aProveFailed');
    }
  };
  const [lapsed, setLapsed] = useState(false);
  // While an offer is open the bank answers the same one again, so asking twice is harmless.
  const start = () => {
    setProblem(null);
    setLapsed(false);
    setOffer(null);
    setSignature('');
    void api
      .mutate('bank', 'ramps.destinations.ownership.start', { destinationId: row.destinationId }, walletProofStartedSchema)
      .then((answer) => (answer.ok ? setOffer(answer.data) : setProblem(words(answer.code))))
      .catch(() => setProblem(t('aProveFailed')));
  };
  useEffect(() => {
    if (asked.current) return;
    asked.current = true;
    start();
    // Asked once for the row this panel opened on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  async function verify(event: FormEvent) {
    event.preventDefault();
    if (!offer || busy || !signature.trim()) return;
    setBusy(true);
    setProblem(null);
    try {
      const answer = await api.mutate(
        'bank',
        'ramps.destinations.ownership.verify',
        { proofId: offer.proofId, signature: signature.trim() },
        walletProofVerifiedSchema,
      );
      if (!answer.ok) {
        setProblem(words(answer.code));
        // A lapsed offer can never be signed now: the form goes, and Start again asks for a new message.
        if (answer.code === 'bank.wallet_proof_expired') setLapsed(true);
        return;
      }
      setProvedUntil(answer.data.validUntil);
      onProved();
    } catch {
      setProblem(t('aProveFailed'));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="bd-stack" data-testid="wallet-proof">
      <strong>{t('aProveTitle', { label: row.label ?? address })}</strong>
      <p>{t('aProveLead', { address })}</p>
      {!offer && !problem && <p role="status">{t('aProveStarting')}</p>}
      {offer && !provedUntil && !lapsed && (
        <form className="bd-stack" onSubmit={verify} noValidate>
          <label data-testid="field" className="field">
            <span>{t('aProveMessage')}</span>
            <textarea readOnly value={offer.message} rows={6} lang="und" data-testid="wallet-proof-message" />
            <small>{t('aProveUntil', { time: date(offer.expiresAt) })}</small>
          </label>
          <p>
            <Button
              variant="ghost"
              onClick={() => {
                void navigator.clipboard?.writeText(offer.message).then(
                  () => setCopied(true),
                  () => setCopied(false),
                );
              }}
            >
              {t('aProveCopy')}
            </Button>
            {copied && <small role="status"> {t('aProveCopied')}</small>}
          </p>
          <label data-testid="field" className="field">
            <span>{t('aProveSignature')}</span>
            <textarea
              value={signature}
              onChange={(event) => {
                setSignature(event.target.value);
                setProblem(null);
              }}
              rows={3}
              lang="und"
              autoComplete="off"
              spellCheck={false}
              aria-describedby="wallet-proof-signature-hint"
            />
            <small id="wallet-proof-signature-hint">{t('aProveSignatureHint')}</small>
          </label>
          <Button type="submit" variant="primary" disabled={busy || !signature.trim()}>
            {t('aProveSubmit')}
          </Button>
          {busy && <p role="status">{t('aProveChecking')}</p>}
        </form>
      )}
      {provedUntil && <p role="status">{t('aProveDone', { time: date(provedUntil) })}</p>}
      {problem && <p role="alert">{problem}</p>}
      <p>
        {lapsed && (
          <Button variant="secondary" onClick={start}>
            {t('aProveAgain')}
          </Button>
        )}
        <Button variant="ghost" onClick={onClose}>
          {t('aProveClose')}
        </Button>
      </p>
    </div>
  );
}

type Draft = { label: string; assetId: string; network: string; address: string; tag: string };
const EMPTY: Draft = { label: '', assetId: '', network: '', address: '', tag: '' };

/**
 * What is wrong with a draft, field by field, before anything is sent. The bank checks the same rules again; this only
 * stops a mistyped entry from costing a confirmation code.
 */
export function draftProblems(draft: Draft, assets: readonly WithdrawAsset[]) {
  const asset = assets.find((a) => a.assetId === draft.assetId);
  const label = checkLabel(draft.label.trim());
  const address = checkAddress(draft.address);
  return {
    label: label === 'ok' ? null : label === 'empty' ? ('aLabelHint' as const) : ('aLabelBad' as const),
    asset: asset ? null : ('aAssetPick' as const),
    network: asset && asset.networks.some((n) => n.networkId === draft.network) ? null : ('aNetworkPick' as const),
    address: address === 'ok' ? null : address === 'empty' ? ('aAddressEmpty' as const) : ('aAddressBad' as const),
    tag: checkTag(draft.tag) === 'ok' ? null : ('aTagBad' as const),
  };
}

/**
 * The add form. Saving needs a fresh confirmation (`trade:withdraw`): the code buys one token, used for this save only.
 * Before the code is asked for, the bank checks the address (`ramps.destinations.check`, W-withdraw-03): a mixed-case
 * address whose checksum does not match is refused at the field, and one that starts and ends like a saved address but
 * is not (address poisoning) shows a warning that must be ticked before it can be saved, and an address on the owner's
 * fraud list for that network is refused at the form, before any code is asked for. The bank checks all three again on save.
 */
function AddForm({ onSaved }: { onSaved: () => void }) {
  const { t } = withdrawalCopy.useCopy();
  const { api } = useSession();
  const networks = useBankRead('ramps.destinations.networks', undefined);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [tried, setTried] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkProblem, setCheckProblem] = useState<string | null>(null);
  const [checksumBad, setChecksumBad] = useState(false);
  const [lookalike, setLookalike] = useState<NonNullable<DestinationCheck['lookalike']> | null>(null);
  const [checked, setChecked] = useState(false);
  const [untickedShown, setUntickedShown] = useState(false);
  // The address and network as typed now, so a check answered after either changed is dropped, not applied to the new pair.
  const typed = useRef('');
  if (networks.resource.status === 'loading') return <Loading />;
  if (networks.resource.status === 'failed') return <Failure result={networks.resource.failure} retry={networks.reload} />;
  const assets = networks.resource.data;
  if (assets.length === 0) return <EmptyState title={t('aNoAssetsTitle')}>{t('aNoAssetsBody')}</EmptyState>;
  const asset = assets.find((a) => a.assetId === draft.assetId);
  const local = draftProblems(draft, assets);
  const problems = { ...local, address: local.address ?? (checksumBad ? ('aAddressChecksum' as const) : null) };
  const shown = (key: keyof typeof problems) => (tried ? problems[key] : null);
  const set = (patch: Partial<Draft>) => {
    setSaved(null);
    setCheckProblem(null);
    if (patch.address !== undefined || patch.network !== undefined) {
      // A new address or network is a new check (the fraud list is per network): the old warning and tick do not carry over.
      typed.current = `${(patch.address ?? draft.address).trim()}|${patch.network ?? draft.network}`;
      setChecksumBad(false);
      setLookalike(null);
      setChecked(false);
      setUntickedShown(false);
    }
    setDraft((before) => ({ ...before, ...patch }));
  };
  const input = {
    assetId: draft.assetId,
    network: draft.network,
    ref: draft.address.trim(),
    label: draft.label.trim(),
    ...(draft.tag ? { tag: draft.tag } : {}),
    ...(lookalike && checked ? { confirmLookalike: true } : {}),
  };
  async function submit(event: FormEvent) {
    event.preventDefault();
    setTried(true);
    if (checking || Object.values(local).some((p) => p !== null)) return;
    if (lookalike) {
      // Already warned about this address: it goes ahead only once ticked.
      if (checked) setConfirming(true);
      else setUntickedShown(true);
      return;
    }
    const ref = input.ref;
    const asked = `${ref}|${input.network}`;
    typed.current = asked;
    setChecking(true);
    setCheckProblem(null);
    try {
      const answer = await api.query('bank', 'ramps.destinations.check', { ref, network: input.network }, destinationCheckSchema);
      if (typed.current !== asked) return;
      if (!answer.ok) {
        setCheckProblem(moneyRefusalWords(answer.code) ?? t('aCheckFailed'));
        return;
      }
      if (answer.data.address !== 'ok') {
        setChecksumBad(answer.data.address === 'checksum_mismatch');
        if (answer.data.address === 'invalid') setCheckProblem(t('aAddressBad'));
        return;
      }
      if (answer.data.fraudListed) {
        setCheckProblem(t('aFraudListed'));
        return;
      }
      if (answer.data.lookalike) {
        setLookalike(answer.data.lookalike);
        return;
      }
      setConfirming(true);
    } catch {
      if (typed.current === asked) setCheckProblem(t('aCheckFailed'));
    } finally {
      setChecking(false);
    }
  }
  return (
    <>
      <form className="bd-stack" onSubmit={submit} noValidate aria-label={t('aAddTitle')}>
        <label data-testid="field" className="field">
          <span>{t('aLabel')}</span>
          <input
            value={draft.label}
            onChange={(event) => set({ label: event.target.value })}
            autoComplete="off"
            aria-invalid={shown('label') ? true : undefined}
            aria-describedby="address-label-hint"
          />
          <small id="address-label-hint" role={shown('label') ? 'alert' : undefined}>
            {t(shown('label') ?? 'aLabelHint')}
          </small>
        </label>
        <label data-testid="field" className="field">
          <span>{t('aAsset')}</span>
          <select
            value={draft.assetId}
            onChange={(event) => {
              const next = assets.find((a) => a.assetId === event.target.value);
              set({ assetId: event.target.value, network: next?.defaultNetworkId ?? next?.networks[0]?.networkId ?? '' });
            }}
            aria-invalid={shown('asset') ? true : undefined}
          >
            <option value="">{t('aAssetAny')}</option>
            {assets.map((a) => (
              <option key={a.assetId} value={a.assetId}>
                {a.assetId}
              </option>
            ))}
          </select>
          {shown('asset') && <small role="alert">{t('aAssetPick')}</small>}
        </label>
        <label data-testid="field" className="field">
          <span>{t('aNetwork')}</span>
          <select
            value={draft.network}
            onChange={(event) => set({ network: event.target.value })}
            disabled={!asset}
            aria-invalid={shown('network') ? true : undefined}
            aria-describedby="address-network-hint"
          >
            {!asset && <option value="">{t('aNetworkFirst')}</option>}
            {asset?.networks.map((n) => (
              <option key={n.networkId} value={n.networkId}>
                {n.label}
              </option>
            ))}
          </select>
          <small id="address-network-hint">{t('aNetworkHint')}</small>
        </label>
        <label data-testid="field" className="field">
          <span>{t('aAddress')}</span>
          <input
            value={draft.address}
            onChange={(event) => set({ address: event.target.value })}
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            aria-invalid={shown('address') ? true : undefined}
            aria-describedby="address-hint"
          />
          <small id="address-hint" role={shown('address') ? 'alert' : undefined}>
            {t(shown('address') ?? 'aAddressHint')}
          </small>
        </label>
        <label data-testid="field" className="field">
          <span>{t('aTag')}</span>
          <input
            value={draft.tag}
            onChange={(event) => set({ tag: event.target.value })}
            autoComplete="off"
            aria-invalid={shown('tag') ? true : undefined}
            aria-describedby="address-tag-hint"
          />
          <small id="address-tag-hint" role={shown('tag') ? 'alert' : undefined}>
            {t(shown('tag') ?? 'aTagHint')}
          </small>
        </label>
        {lookalike && (
          <div className="bd-stack" role="alert" data-testid="address-lookalike">
            <strong>{t('aLookalikeTitle')}</strong>
            <p>
              {lookalike.label
                ? t('aLookalikeBody', { saved: lookalike.label, address: lookalike.refMasked })
                : t('aLookalikeBodyUnnamed', { address: lookalike.refMasked })}
            </p>
            <label className="money-check">
              <input
                type="checkbox"
                checked={checked}
                onChange={(event) => {
                  setChecked(event.target.checked);
                  setUntickedShown(false);
                }}
              />
              <span>{t('aLookalikeConfirm')}</span>
            </label>
            {untickedShown && !checked && <small role="alert">{t('aLookalikeUnticked')}</small>}
          </div>
        )}
        <p>{t('aSaveNote')}</p>
        <Button type="submit" variant="primary" disabled={checking}>
          {t('aSave')}
        </Button>
        {checking && <p role="status">{t('aChecking')}</p>}
        {checkProblem && <p role="alert">{checkProblem}</p>}
        {saved && <p role="status">{t('aSaved', { label: saved })}</p>}
      </form>
      {confirming && (
        <WithdrawStepUp
          why={t('aSaveWhy')}
          run={async (token) => {
            const answer = await api.mutate('bank', 'ramps.destinations.save', input, destinationSchema, { bearer: token });
            // The three address refusals in the customer's own words; the check above makes them rare.
            if (!answer.ok && answer.code === 'bank.address_lookalike') return { ...answer, message: t('aLookalikeRefused') };
            if (!answer.ok && answer.code === 'bank.address_checksum_mismatch') return { ...answer, message: t('aAddressChecksum') };
            if (!answer.ok && answer.code === 'bank.destination_fraud_listed') return { ...answer, message: t('aFraudListed') };
            // The security lock's refusals in the customer's words; any other refusal keeps the bank's own sentence.
            return !answer.ok && lockRefusal(answer.code) ? { ...answer, message: moneyRefusalWords(answer.code)! } : answer;
          }}
          onDone={() => {
            setConfirming(false);
            setSaved(input.label);
            setDraft(EMPTY);
            setTried(false);
            setLookalike(null);
            setChecked(false);
            onSaved();
          }}
          onCancel={() => setConfirming(false)}
        />
      )}
    </>
  );
}

/**
 * `/uc/withdraw/address`: the address book and the form to add to it. The book is the bank's own saved-destination read
 * (`bank.ramps.destinations.list`); the assets and networks offered are the bank's read of the ledger's asset list. Saving
 * and removing each ask for a fresh confirmation; renaming does not, because it cannot change where money goes.
 */
export function WithdrawalAddresses({ open }: { open?: (spec: ActionSpec) => void } = {}) {
  const { t } = withdrawalCopy.useCopy();
  const { api } = useSession();
  const book = useBankRead('ramps.destinations.list', undefined);
  const [removing, setRemoving] = useState<Destination | null>(null);
  const [removed, setRemoved] = useState<string | null>(null);
  const [proving, setProving] = useState<Destination | null>(null);
  const [using, setUsing] = useState<Destination | null>(null);
  // Renaming changes only the label (`bank:write`), so it needs no confirmation.
  const rename = open
    ? (row: Destination) =>
        open({
          title: t('aRenameTitle'),
          procedure: 'ramps.destinations.rename',
          facts: [[t('aRenameAddress'), shortenAddress(row.ref)]],
          initial: { label: row.label ?? '' },
          fields: [
            {
              name: 'label',
              label: t('aLabel'),
              validate: (value) => (checkLabel(value.trim()) === 'ok' ? null : t('aLabelHint')),
            },
          ],
          notes: [t('aRenameNote')],
          input: (values) => ({ destinationId: row.destinationId, label: values.label!.trim() }),
          verifyOutcome: (data, input) => (data as { destinationId?: string; label?: string | null }).label === input.label,
          submit: t('aRenameSubmit'),
        })
    : undefined;
  return (
    <Page eyebrow={t('aEyebrow')} title={t('aTitle')} description={t('aLead')}>
      <div className="withdrawal-page bd-stack">
        <DepthPanel title={t('aTableTitle')}>
          <AddressBook
            resource={book.resource}
            reload={book.reload}
            onRename={rename}
            onRemove={(row) => {
              setRemoved(null);
              setRemoving(row);
            }}
            onProve={(row) => setProving(row)}
            onUse={(row) => setUsing(row)}
          />
          {using && <UseAddress key={using.destinationId} row={using} onClose={() => setUsing(null)} onApproved={book.reload} />}
          {removed && <p role="status">{t('aRemoved', { label: removed })}</p>}
          {proving && <ProveOwnership key={proving.destinationId} row={proving} onProved={book.reload} onClose={() => setProving(null)} />}
        </DepthPanel>
        <DepthPanel title={t('aAddTitle')}>
          <AddForm onSaved={book.reload} />
        </DepthPanel>
        {removing && (
          <WithdrawStepUp
            why={t('aRemoveWhy', { address: shortenAddress(removing.ref) })}
            run={(token) =>
              api.mutate(
                'bank',
                'ramps.destinations.remove',
                // One removal of one entry: a retry of it is the same request.
                { destinationId: removing.destinationId, idempotencyKey: `destination-remove:${removing.destinationId}` },
                destinationRemovedSchema,
                { bearer: token },
              )
            }
            onDone={() => {
              setRemoved(removing.label ?? shortenAddress(removing.ref));
              // An answer about the removed address no longer stands.
              if (using?.destinationId === removing.destinationId) setUsing(null);
              setRemoving(null);
              book.reload();
            }}
            onCancel={() => setRemoving(null)}
          />
        )}
        <p>
          <a className="text-link" href="/uc/withdraw">
            {t('aBack')} ↗
          </a>
        </p>
      </div>
    </Page>
  );
}

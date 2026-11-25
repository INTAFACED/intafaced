// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let answer: unknown;
const asked: { path: string; input: unknown }[] = [];

vi.mock('../../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});
vi.mock('../../session/session', () => {
  const api = {
    // As the real client does: an answer this caller's `accept` refuses reads as an unverified one.
    async call(record: { path: string }, input: unknown, opts?: { accept?: (data: unknown) => boolean }) {
      asked.push({ path: record.path, input });
      const reply = answer as { ok: boolean; data?: unknown };
      if (reply.ok && opts?.accept && !opts.accept(reply.data)) return { ok: false, reason: 'invalid_response', message: 'unverified' };
      return answer;
    },
  };
  return { useApi: () => api, useSession: () => ({ userId: 'u-test' }) };
});

const { TokenProposalRoom } = await import('./TokenProposalRoom');

const ID = 'gov:proposal:ifc:u-test:7';
const proposal = {
  id: ID,
  kind: 'fee_param',
  body: { title: 'TEST lower the maker fee', bps: 2 },
  status: 'open',
  opensAt: '2026-11-20T10:00:00.000Z',
  closesAt: '2026-11-27T10:00:00.000Z',
  createdAt: '2026-11-19T09:30:00.000Z',
  title: null,
  bodyMd: 'TEST text of the proposal',
  discussionLink: 'javascript:alert(1)',
  businessKey: null,
  authorId: null,
  revision: 0,
  votingType: 'basic',
  choices: null,
  snapshot: null,
  ranking: null,
  cancel: null,
  counts: { votes: 3, for: 2, against: 1, abstain: 0 },
  tally: { forWeight: '120.5', againstWeight: '30', abstainWeight: '0', totalWeight: '150.5', voterCount: 3 },
  choiceTally: null,
};

/** The value a details row shows beside its label. */
function row(host: HTMLElement, label: string) {
  const dt = [...host.querySelectorAll('dt')].find((d) => d.textContent === label);
  return dt?.nextElementSibling?.querySelector('bdi')?.textContent;
}

async function mount(proposalId: string | null) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(<TokenProposalRoom proposalId={proposalId} paper={false} />));
  return host;
}

beforeEach(() => {
  asked.length = 0;
});

describe('/token/governance/:proposalId', () => {
  it('shows the proposal svc-token answers: its title, status, window, text, terms and tally, and where to vote', async () => {
    answer = { ok: true, data: proposal };
    const host = await mount(ID);
    await vi.waitFor(() => expect(host.textContent).toContain('TEST lower the maker fee'));
    expect(asked).toEqual([{ path: 'getProposal', input: { proposalId: ID } }]);
    const text = host.textContent ?? '';
    expect(row(host, 'Status')).toBe('Open');
    expect(row(host, 'Kind')).toBe('Fee parameter');
    expect(row(host, 'Voting type')).toBe('For, against or abstain');
    expect(row(host, 'Closes · UTC')).toBe('2026-11-27 10:00:00 UTC');
    expect(row(host, 'For')).toBe('120.5');
    expect(row(host, 'Total weight')).toBe('150.5');
    for (const words of ['TEST text of the proposal', '"bps": 2', 'To vote, open this proposal in Token governance.'])
      expect(text).toContain(words);
    expect(host.querySelector('time[datetime="2026-11-20T10:00:00.000Z"]')).not.toBeNull();
    expect(host.querySelector('a[href="/token/governance"]')?.textContent).toBe('Open Token governance');
    expect(text).not.toContain('No details are shown for this record');
  });

  it('opens a discussion link only on a web address, and shows any other as text', async () => {
    answer = { ok: true, data: proposal };
    const host = await mount(ID);
    await vi.waitFor(() => expect(host.textContent).toContain('javascript:alert(1)'));
    expect(host.querySelector('a[href^="javascript"]')).toBeNull();
    answer = { ok: true, data: { ...proposal, id: 'gov:proposal:ifc:u-test:8', discussionLink: 'https://forum.example/t/8' } };
    const linked = await mount('gov:proposal:ifc:u-test:8');
    await vi.waitFor(() => expect(linked.querySelector('a[href="https://forum.example/t/8"]')).not.toBeNull());
  });

  it('names each choice with its rank on a ranked proposal, says the weights are the first round, and offers no vote once closed', async () => {
    answer = {
      ok: true,
      data: {
        ...proposal,
        status: 'closed_ranked',
        votingType: 'ranked_choice',
        choices: ['TEST alpha', 'TEST beta', 'TEST gamma'],
        ranking: [1, 0, 2],
        choiceTally: {
          totals: ['40', '35', '25'],
          abstainWeight: '0',
          participatingWeight: '100',
          voterCount: 4,
          ranking: [1, 0, 2],
          rounds: [
            ['40', '35', '25'],
            ['45', '55', '0'],
          ],
        },
      },
    };
    const host = await mount(ID);
    await vi.waitFor(() => expect(host.textContent).toContain('Choice tally'));
    expect(row(host, 'Status')).toBe('Closed, ranking stored');
    const note = (label: string) =>
      [...host.querySelectorAll('dt')].find((d) => d.textContent === label)?.nextElementSibling?.querySelector('.lt-kv-note')?.textContent;
    expect(note('2. TEST beta')).toBe('Rank 1');
    expect(note('1. TEST alpha')).toBe('Rank 2');
    expect(host.textContent).toContain('counted over 2 rounds');
    expect(host.textContent).not.toContain('To vote');
  });

  it('shows a proposal with an instant that is not one as a failed read, not a crash', async () => {
    answer = { ok: true, data: { ...proposal, createdAt: 'invalid' } };
    const host = await mount(ID);
    await vi.waitFor(() => expect(host.textContent).not.toContain('Loading'));
    expect(host.textContent).not.toContain('TEST lower the maker fee');
    expect(host.querySelector('[data-room="token-proposal"]')).not.toBeNull();
  });

  it("says an id the service doesn't know is no proposal, with its code and the way to governance", async () => {
    answer = {
      ok: false,
      reason: 'not_mounted',
      message: 'We could not find that proposal.',
      code: 'token.proposal_not_found',
      status: 404,
    };
    const host = await mount('gov:proposal:ifc:u-test:404');
    await vi.waitFor(() => expect(host.textContent).toContain('No proposal has this id'));
    expect(host.querySelector('code')?.textContent).toBe('token.proposal_not_found');
    expect(host.querySelector('a[href="/token/governance"]')).not.toBeNull();
  });

  it('refuses an id the route refused without asking the service', async () => {
    const host = await mount(null);
    expect(host.textContent).toContain('That address is not valid');
    expect(asked).toEqual([]);
  });
});

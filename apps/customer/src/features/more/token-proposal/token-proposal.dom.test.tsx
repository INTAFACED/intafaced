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
    async call(record: { path: string }, input: unknown) {
      asked.push({ path: record.path, input });
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
    for (const words of [
      'Fee parameter',
      'Open',
      'For, against or abstain',
      '2026-11-27 10:00 UTC',
      'TEST text of the proposal',
      '"bps": 2',
      '120.5',
      '150.5',
    ])
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

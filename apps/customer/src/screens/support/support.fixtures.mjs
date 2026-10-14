// Mocked answers for the Support screen test. Labelled test data only: made-up ids, no real account.
export const owner = '00000000-0000-4000-8000-000000000001';
export const trpc = (data) => ({ result: { data } });
export const failure = {
  status: 503,
  json: { error: { message: 'Isolated read failed', code: -32603, data: { code: 'SERVICE_UNAVAILABLE', httpStatus: 503 } } },
};

const article = (id, key) => ({ id, titleKey: `support.kb.${key}.title`, bodyKey: `support.kb.${key}.body`, version: 1, published: true });
export const articles = () => [
  article('kb-account-access', 'account_access'),
  article('kb-security-basics', 'security_basics'),
  article('kb-orders-status', 'orders_status'),
  article('kb-deposit-withdraw-honest', 'deposit_withdraw'),
  article('kb-paper-vs-live', 'paper_vs_live'),
];

export const ticketId = (n) => `aaaaaaaa-aaaa-4aaa-8aaa-00000000000${n}`;
export const ticket = (n, extra = {}) => ({
  id: ticketId(n),
  userId: owner,
  category: 'account',
  subject: `Test request ${n}`,
  body: `This is test request ${n}.\n\nIt has a second paragraph.`,
  status: 'open',
  assigneeId: null,
  createdAt: '2026-10-12T09:00:00.000Z',
  updatedAt: '2026-10-13T09:30:00.000Z',
  ...extra,
});
export const tickets = () => [
  ticket(1),
  ticket(2, { status: 'resolved', subject: 'Test request two', updatedAt: '2026-10-11T10:00:00.000Z' }),
];
export const comment = (n, role, body) => ({
  id: `bbbbbbbb-bbbb-4bbb-8bbb-00000000000${n}`,
  ticketId: ticketId(1),
  authorId: role === 'user' ? owner : 'cccccccc-cccc-4ccc-8ccc-000000000001',
  authorRole: role,
  body,
  createdAt: `2026-10-13T0${n}:00:00.000Z`,
});
export const comments = () => [comment(5, 'operator', 'Thanks for writing in. We are looking at it.')];
export const events = () => [
  {
    id: 'dddddddd-dddd-4ddd-8ddd-000000000001',
    ticketId: ticketId(1),
    sequence: 1,
    kind: 'opened',
    actorId: owner,
    actorRole: 'user',
    fromStatus: null,
    toStatus: null,
    note: null,
    occurredAt: '2026-10-12T09:00:00.000Z',
  },
];

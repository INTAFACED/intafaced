import { z } from 'zod';
import type { ApiClient } from '../../shared/api';

/** The shapes svc-support answers with, checked here before anything is shown (the same checks the older Support view made). */
export const categories = ['account', 'trading', 'deposit_withdraw', 'other'] as const;
export type Category = (typeof categories)[number];
export const ticketStatuses = ['open', 'pending', 'resolved', 'closed'] as const;
export type TicketStatus = (typeof ticketStatuses)[number];

export const ticketSchema = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
  category: z.enum(categories),
  subject: z.string().min(1).max(200),
  body: z.string().min(1).max(10000),
  status: z.enum(ticketStatuses),
  assigneeId: z.string().uuid().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Ticket = z.infer<typeof ticketSchema>;

export const commentSchema = z.object({
  id: z.string().uuid(),
  ticketId: z.string().uuid(),
  authorId: z.string().uuid(),
  authorRole: z.enum(['user', 'operator']),
  body: z.string(),
  createdAt: z.string(),
});
export type Comment = z.infer<typeof commentSchema>;

export const articleSchema = z.object({
  id: z.string(),
  titleKey: z.string(),
  bodyKey: z.string(),
  version: z.number().int().positive().optional(),
  published: z.boolean().optional(),
});
export type Article = z.infer<typeof articleSchema>;

export const searchArticles = (api: ApiClient, q: string, signal?: AbortSignal) =>
  api.query('support', 'searchKb', { q, limit: 50 }, z.array(articleSchema), { signal });

export const listMine = (api: ApiClient, userId: string | null, limit: number, signal?: AbortSignal) =>
  api.query(
    'support',
    'listMine',
    { limit },
    z.array(ticketSchema).refine((rows) => rows.every((row) => row.userId === userId)),
    { signal },
  );

export const getTicket = (api: ApiClient, userId: string | null, ticketId: string, signal?: AbortSignal) =>
  api.query(
    'support',
    'get',
    { ticketId },
    ticketSchema.refine((row) => row.id === ticketId && row.userId === userId),
    { signal },
  );

export const listComments = (api: ApiClient, ticketId: string, limit: number, signal?: AbortSignal) =>
  api.query(
    'support',
    'listComments',
    { ticketId, limit },
    z.array(commentSchema).refine((rows) => rows.every((row) => row.ticketId === ticketId)),
    {
      signal,
    },
  );

/** One call; the answer must be the ticket just described, for this person. */
export const createTicket = (api: ApiClient, userId: string | null, input: { category: Category; subject: string; body: string }) =>
  api.mutate(
    'support',
    'create',
    input,
    ticketSchema.refine(
      (row) => row.userId === userId && row.subject === input.subject && row.body === input.body && row.category === input.category,
    ),
  );

export const postComment = (api: ApiClient, userId: string | null, ticketId: string, body: string) =>
  api.mutate(
    'support',
    'comment',
    { ticketId, body },
    commentSchema.refine((row) => row.ticketId === ticketId && row.authorId === userId && row.authorRole === 'user' && row.body === body),
  );

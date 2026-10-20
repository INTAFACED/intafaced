import { z } from 'zod';

/** What the support service returns, as this app checks it. Kept in one place so the list, the detail and the form agree. */
export const ticketSchema = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
  category: z.enum(['account', 'trading', 'deposit_withdraw', 'phishing', 'other']),
  subject: z.string().min(1).max(200),
  body: z.string().min(1).max(10000),
  status: z.enum(['open', 'pending', 'on_hold', 'resolved', 'closed']),
  assigneeId: z.string().uuid().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export const commentSchema = z.object({
  id: z.string().uuid(),
  ticketId: z.string().uuid(),
  authorId: z.string().uuid(),
  authorRole: z.enum(['user', 'operator']),
  body: z.string(),
  createdAt: z.string(),
});
export const kbSchema = z.object({
  id: z.string(),
  titleKey: z.string(),
  bodyKey: z.string(),
  version: z.number().int().positive().optional(),
  published: z.boolean().optional(),
  category: z.string().optional(),
  tags: z.array(z.string()).optional(),
});
export type Ticket = z.infer<typeof ticketSchema>;
export type Comment = z.infer<typeof commentSchema>;
export type KbArticle = z.infer<typeof kbSchema>;

export const CATEGORY_VALUES = ['account', 'trading', 'deposit_withdraw', 'phishing', 'other'] as const;

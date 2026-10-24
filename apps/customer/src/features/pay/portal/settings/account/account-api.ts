import { z } from 'zod';
import * as p from '../../schemas';
import { type PortalTools } from '../../api-tools';
import * as s from './schemas';
import './refusals';

const cursorPart = (cursor: string | undefined) => (cursor ? { cursor } : {});

/**
 * The calls the account pages make that no shared client has: the business profile, setup progress, the activity
 * feed, the filtered team list and the platform network. The business is always passed by the page from the
 * resolved access; the service checks it against the signed session again.
 */
export const accountApi = ({ query, mutate, list }: PortalTools) => ({
  // ---- business profile (merchant.businessProfile.*) ----
  profileGet: (merchantId: string, signal?: AbortSignal) => query('merchant.businessProfile.get', { merchantId }, s.profileSchema, signal),
  profileHistory: (merchantId: string, cursor: string | undefined, signal?: AbortSignal) =>
    query('merchant.businessProfile.history', { merchantId, limit: 25, ...cursorPart(cursor) }, p.page(s.profileChangeSchema), signal),
  profileSubmit: (input: { merchantId: string; expectedVersion: string; reason: string } & Partial<s.ProfileFields>) =>
    mutate('merchant.businessProfile.submit', input, s.profileSubmitResultSchema),
  profileConfirm: (input: {
    merchantId: string;
    requestId: string;
    decision: 'confirm' | 'reject' | 'withdraw';
    expectedChangeHash: string;
    reason: string;
  }) => mutate('merchant.businessProfile.confirm', input, s.profileDecideResultSchema),
  termsAccept: (merchantId: string, version: string) => mutate('merchant.terms.accept', { merchantId, version }, s.termsAcceptedSchema),
  profileSecondApproval: (merchantId: string, enabled: boolean) =>
    mutate('merchant.businessProfile.setSecondApproval', { merchantId, enabled }, s.secondApprovalResultSchema),
  onboardingProgress: (merchantId: string, signal?: AbortSignal) =>
    query('merchant.onboarding.progress', { merchantId }, s.progressSchema, signal),

  // ---- team, with the filters the service now applies ----
  teamPage: (cursor: string | undefined, filters: { status?: string; role?: string; search?: string }, signal?: AbortSignal) =>
    list(
      'merchantOps.team.list',
      p.memberSchema,
      {
        ...cursorPart(cursor),
        ...(filters.status ? { status: filters.status } : {}),
        ...(filters.role ? { role: filters.role } : {}),
        ...(filters.search ? { search: filters.search } : {}),
      },
      signal,
    ),

  // ---- activity ----
  activityList: (
    cursor: string | undefined,
    filters: { objectType?: string; action?: string; actorId?: string; from?: string; to?: string; search?: string },
    signal?: AbortSignal,
  ) =>
    list(
      'merchantOps.activity.list',
      s.activityItemSchema,
      {
        ...cursorPart(cursor),
        ...Object.fromEntries(Object.entries(filters).filter(([, v]) => v)),
      },
      signal,
    ),

  // ---- network ----
  subList: (merchantId: string, signal?: AbortSignal) =>
    query('submerchant.list', { merchantId, limit: 100 }, z.array(s.subMerchantSchema), signal),
  subGet: (merchantId: string, signal?: AbortSignal) => query('submerchant.get', { merchantId }, s.subMerchantSchema, signal),
  subSummary: (merchantId: string, signal?: AbortSignal) =>
    query('submerchant.summary', { merchantId, recentPaymentsLimit: 10, grantsLimit: 50 }, s.subSummarySchema, signal),
  subCreate: (input: { parentMerchantId: string; userId: string; feeBps: number }) =>
    mutate(
      'submerchant.create',
      { parentMerchantId: input.parentMerchantId, userId: input.userId, pricing: { feeBps: input.feeBps } },
      s.subMerchantSchema,
    ),
  permAreas: (signal?: AbortSignal) => query('submerchantPermission.areas', undefined, z.array(z.string()), signal),
  permGrants: (subjectMerchantId: string, signal?: AbortSignal) =>
    query('submerchantPermission.list', { subjectMerchantId, limit: 50 }, z.array(s.grantSchema), signal),
  permHistory: (subjectMerchantId: string, signal?: AbortSignal) =>
    query('submerchantPermission.history', { subjectMerchantId, limit: 50 }, z.array(s.permissionEventSchema), signal),
  permGrant: (input: { granteeMerchantId: string; subjectMerchantId: string; area: string; reason: string }) =>
    mutate('submerchantPermission.grant', input, s.permissionEventSchema),
  permRevoke: (input: { granteeMerchantId: string; subjectMerchantId: string; area: string; reason: string }) =>
    mutate('submerchantPermission.revoke', input, s.permissionEventSchema),
});

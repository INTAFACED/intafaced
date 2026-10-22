import { z } from 'zod';

/** Published permission list (AC-roles-01). `refund` only authorises REQUESTING a refund. */
export const academyPermissionSchema = z.enum([
  'publish',
  'delete',
  'edit_content',
  'view_progress',
  'grade',
  'enrol',
  'moderate',
  'reports',
  'certificates',
  'refund',
  'financial_view',
  'comments',
  'coaching',
]);
export type AcademyPermission = z.infer<typeof academyPermissionSchema>;

export const academyBuiltinRoleSchema = z.enum(['instructor', 'staff', 'limited_staff', 'admin', 'data_researcher', 'author']);
export type AcademyBuiltinRole = z.infer<typeof academyBuiltinRoleSchema>;

/** Built-in role id or `custom:<slug>`. */
export const academyRoleIdSchema = z.union([
  academyBuiltinRoleSchema,
  z
    .string()
    .regex(/^custom:[a-z0-9]+(?:-[a-z0-9]+)*$/)
    .max(71),
]);

/** Course id, curriculum path slug, or '*' for academy-wide. */
export const academyCourseScopeSchema = z.string().min(1).max(64);

export const academyCustomRoleSchema = z
  .object({
    id: academyRoleIdSchema,
    label: z.string().trim().min(1).max(80),
    permissions: z.array(academyPermissionSchema).max(13),
    active: z.boolean(),
  })
  .strict();
export const academyRoleHolderSchema = z
  .object({
    courseScope: academyCourseScopeSchema,
    accountId: z.string().uuid(),
    role: academyRoleIdSchema,
    activation: z.number().int().nonnegative().safe(),
    active: z.boolean(),
  })
  .strict();
export const academyRolesCatalogueSchema = z
  .object({
    permissions: z.array(academyPermissionSchema),
    builtin: z.array(z.object({ id: academyBuiltinRoleSchema, permissions: z.array(academyPermissionSchema) })),
    custom: z.array(academyCustomRoleSchema),
  })
  .strict();

/** Two-founder action types bound by identity action approvals (targetService 'svc-academy', targetId = action type). */
export const ACADEMY_ROLE_ACTION_TYPES = [
  'academy.role.create', // payload fields: slug, label, permissions (sorted, comma-joined)
  'academy.role.activate', // payload fields: roleId, active ('true'|'false')
  'academy.role.assign', // payload fields: courseScope, accountId, role
  'academy.role.revoke', // payload fields: courseScope, accountId, role
] as const;
export const academyRoleActionTypeSchema = z.enum(ACADEMY_ROLE_ACTION_TYPES);
export type AcademyRoleActionType = (typeof ACADEMY_ROLE_ACTION_TYPES)[number];

/** New refusal codes clients branch on. */
export const ACADEMY_ROLE_REFUSAL_CODES = [
  'academy.permission_denied',
  'academy.role_limit_unset',
  'academy.role_limit_reached',
  'academy.role_not_found',
  'academy.role_escalation',
  'academy.role_invalid',
  'academy.role_holders_list_limit_unset',
] as const;
export type AcademyRoleRefusalCode = (typeof ACADEMY_ROLE_REFUSAL_CODES)[number];

/** Approval payload fields per action type (identity action approvals, targetService 'svc-academy'). Strings only. */
const slug = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  .max(64);
export const academyRoleActionPayloadSchema = z.discriminatedUnion('actionType', [
  z
    .object({
      actionType: z.literal('academy.role.create'),
      slug,
      label: z.string().trim().min(1).max(80),
      /** Sorted, comma-joined permission list. */
      permissions: z.string().refine((v) => {
        const parts = v.split(',');
        return parts.every((p) => academyPermissionSchema.safeParse(p).success) && parts.join(',') === [...new Set(parts)].sort().join(',');
      }, 'permissions are sorted, unique and comma-joined'),
    })
    .strict(),
  z.object({ actionType: z.literal('academy.role.activate'), roleId: academyRoleIdSchema, active: z.enum(['true', 'false']) }).strict(),
  z
    .object({
      actionType: z.literal('academy.role.assign'),
      courseScope: academyCourseScopeSchema,
      accountId: z.string().uuid(),
      role: academyRoleIdSchema,
    })
    .strict(),
  z
    .object({
      actionType: z.literal('academy.role.revoke'),
      courseScope: academyCourseScopeSchema,
      accountId: z.string().uuid(),
      role: academyRoleIdSchema,
    })
    .strict(),
]);
export type AcademyRoleActionPayload = z.infer<typeof academyRoleActionPayloadSchema>;

export const academyCoursePermissionSchema = z.object({ allowed: z.boolean() }).strict();

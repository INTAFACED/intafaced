-- svc-support · case file citation and grounding shape (L1241)
-- Reversal: 0007_support_citation_shape.down.sql
--
-- NOT tagged `intafaced:destructive`: it replaces case_files_grounded_ck
-- in place. It drops no table, no column, and no row. The same constraint
-- name comes back stricter. There is still no amount column.
--
-- 0001 required citations to be a non-empty jsonb array. An array of empty
-- objects, or a citation whose ref is blank, passed. grounding had no shape
-- check, so a blank status was stored.
--
-- A citation is {kind, ref, digest, readAt}. kind is one of the published
-- citation kinds (kb_article, account_state, ticket_comment). digest is the
-- sha256 hex supportCitationSchema already requires. ref and readAt are
-- non-blank. grounding is supportAccountGroundingSchema. A read carries
-- accountStateSchema — userId, status (active, frozen, closed), and kycTier
-- (none, basic, full, institutional) — plus readAt. An unread record names
-- plane_dark or not_attempted. A blank status matches neither arm.
--
-- A CHECK that comes out NULL is treated as passed. Missing keys make jsonb
-- comparisons NULL, so each predicate is COALESCE'd to false. jsonb_array_length
-- throws on a non-array, so that call stays in a CASE arm that runs only
-- after the array check.

CREATE OR REPLACE FUNCTION "support"."case_file_is_grounded"("citations" jsonb, "grounding" jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT CASE
    WHEN jsonb_typeof("citations") IS DISTINCT FROM 'array' THEN false
    WHEN jsonb_array_length("citations") < 1 THEN false
    WHEN EXISTS (
      SELECT 1
        FROM jsonb_array_elements("citations") AS c
       WHERE NOT COALESCE(
             jsonb_typeof(c) = 'object'
         AND jsonb_typeof(c -> 'kind') = 'string'
         AND (c ->> 'kind') IN ('kb_article', 'account_state', 'ticket_comment')
         AND jsonb_typeof(c -> 'ref') = 'string'
         AND char_length(c ->> 'ref') BETWEEN 1 AND 200
         AND (c ->> 'ref') ~ '[^[:space:]]'
         AND jsonb_typeof(c -> 'digest') = 'string'
         AND (c ->> 'digest') ~ '^[0-9a-f]{64}$'
         AND jsonb_typeof(c -> 'readAt') = 'string'
         AND (c ->> 'readAt') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?Z$'
       , false)
    ) THEN false
    WHEN NOT COALESCE(
          jsonb_typeof("grounding") = 'object'
      AND (
        (
              jsonb_typeof("grounding" -> 'status') = 'string'
          AND ("grounding" ->> 'status') = 'read'
          AND jsonb_typeof("grounding" -> 'state') = 'object'
          AND jsonb_typeof("grounding" -> 'state' -> 'userId') = 'string'
          AND ("grounding" -> 'state' ->> 'userId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          AND jsonb_typeof("grounding" -> 'state' -> 'status') = 'string'
          AND ("grounding" -> 'state' ->> 'status') IN ('active', 'frozen', 'closed')
          AND jsonb_typeof("grounding" -> 'state' -> 'kycTier') = 'string'
          AND ("grounding" -> 'state' ->> 'kycTier') IN ('none', 'basic', 'full', 'institutional')
          AND jsonb_typeof("grounding" -> 'readAt') = 'string'
          AND ("grounding" ->> 'readAt') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?Z$'
        )
        OR (
              jsonb_typeof("grounding" -> 'status') = 'string'
          AND ("grounding" ->> 'status') = 'unread'
          AND jsonb_typeof("grounding" -> 'reason') = 'string'
          AND ("grounding" ->> 'reason') IN ('plane_dark', 'not_attempted')
        )
      )
    , false) THEN false
    ELSE true
  END;
$$;

ALTER TABLE "support"."case_files" DROP CONSTRAINT IF EXISTS "case_files_grounded_ck";
ALTER TABLE "support"."case_files" ADD CONSTRAINT "case_files_grounded_ck"
  CHECK ("support"."case_file_is_grounded"("citations", "grounding"));

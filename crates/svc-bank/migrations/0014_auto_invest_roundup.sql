-- Card round-ups (§31:805). Enum label first — PG cannot use a newly added
-- value until this statement commits. Shape + unique index land in 0015.

ALTER TYPE "bank"."auto_invest_kind" ADD VALUE IF NOT EXISTS 'card_roundup';

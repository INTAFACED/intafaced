-- J-more-catalogue-11. Token launch events: issuers and their review state, the event and its periods,
-- the allocation rule and the terms as stored, and the holdings snapshot an allocation by holdings reads.
-- No price, cap or weight is written here. Blank stays blank, and the reader says "not set".
-- Nothing here moves value or holds a balance: a snapshot row is a measurement of stake, not a claim.

CREATE TABLE IF NOT EXISTS "token"."launch_issuers" (
  "id" text PRIMARY KEY,
  "name" text NOT NULL,
  "state" text NOT NULL DEFAULT 'applied',
  "revision" integer NOT NULL DEFAULT 0,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "launch_issuers_id_ck" CHECK ("id" ~ '^[a-z0-9][a-z0-9-]{2,62}$'),
  CONSTRAINT "launch_issuers_name_ck" CHECK (char_length("name") BETWEEN 1 AND 120),
  CONSTRAINT "launch_issuers_state_ck" CHECK ("state" IN ('applied', 'reviewing', 'onboarded', 'suspended'))
);

-- Every issuer state change, with who asked and who approved. The ordinal is the issuer's revision after the move.
CREATE TABLE IF NOT EXISTS "token"."launch_issuer_moves" (
  "issuer_id" text NOT NULL REFERENCES "token"."launch_issuers" ("id"),
  "ordinal" integer NOT NULL,
  "from_state" text,
  "to_state" text NOT NULL,
  "actor_id" text NOT NULL,
  "approver_id" text NOT NULL,
  "at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("issuer_id", "ordinal")
);

CREATE TABLE IF NOT EXISTS "token"."launch_events" (
  "id" text PRIMARY KEY,
  "issuer_id" text NOT NULL REFERENCES "token"."launch_issuers" ("id"),
  "type" text NOT NULL,
  "project_name" text NOT NULL,
  "symbol" text NOT NULL,
  "announce_at" timestamptz NOT NULL,
  "snapshot_at" timestamptz NOT NULL,
  "open_at" timestamptz NOT NULL,
  "close_at" timestamptz NOT NULL,
  "distribution_at" timestamptz NOT NULL,
  "status" text NOT NULL DEFAULT 'draft',
  "allocation_method" text,
  "per_user_cap" numeric(38, 18),
  "ticket_size" numeric(38, 18),
  "tier_weights" jsonb,
  "price" numeric(38, 18),
  "payment_asset" text,
  "rate_source" text,
  "snapshot_count" integer,
  "snapshot_total" numeric(38, 18),
  "snapshot_hash" text,
  "snapshot_taken_at" timestamptz,
  "revision" integer NOT NULL DEFAULT 0,
  -- Who announced the draft, and the second person whose approval let them.
  "created_by" text NOT NULL,
  "approved_by" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "launch_events_two_people_ck" CHECK ("created_by" <> "approved_by"),
  CONSTRAINT "launch_events_id_ck" CHECK ("id" ~ '^[a-z0-9][a-z0-9-]{2,62}$'),
  CONSTRAINT "launch_events_type_ck" CHECK ("type" IN ('token_sale', 'whitelist_drop', 'primary_subscription')),
  CONSTRAINT "launch_events_project_ck" CHECK (char_length("project_name") BETWEEN 1 AND 120),
  CONSTRAINT "launch_events_symbol_ck" CHECK ("symbol" ~ '^[A-Z0-9]{2,12}$'),
  CONSTRAINT "launch_events_periods_ck" CHECK (
    "announce_at" <= "snapshot_at" AND "snapshot_at" <= "open_at" AND "open_at" < "close_at" AND "close_at" <= "distribution_at"
  ),
  CONSTRAINT "launch_events_status_ck" CHECK (
    "status" IN ('draft', 'announced', 'snapshot', 'open', 'closed', 'allocated', 'distributing', 'complete', 'cancelled')
  ),
  CONSTRAINT "launch_events_method_ck" CHECK ("allocation_method" IS NULL OR "allocation_method" IN ('pro_rata', 'tickets', 'tiered')),
  CONSTRAINT "launch_events_cap_ck" CHECK ("per_user_cap" IS NULL OR "per_user_cap" > 0),
  CONSTRAINT "launch_events_ticket_ck" CHECK ("ticket_size" IS NULL OR "ticket_size" > 0),
  -- A price is only a price with the asset it is paid in.
  CONSTRAINT "launch_events_price_ck" CHECK (("price" IS NULL) = ("payment_asset" IS NULL) AND ("price" IS NULL OR "price" > 0)),
  CONSTRAINT "launch_events_rate_ck" CHECK ("rate_source" IS NULL OR "price" IS NOT NULL),
  -- The seal is all four or none.
  CONSTRAINT "launch_events_seal_ck" CHECK (
    ("snapshot_count" IS NULL) = ("snapshot_total" IS NULL)
    AND ("snapshot_total" IS NULL) = ("snapshot_hash" IS NULL)
    AND ("snapshot_hash" IS NULL) = ("snapshot_taken_at" IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS "launch_events_status_open_idx" ON "token"."launch_events" ("status", "open_at");

-- Every event status change. The ordinal is the event's revision after the move.
CREATE TABLE IF NOT EXISTS "token"."launch_event_moves" (
  "event_id" text NOT NULL REFERENCES "token"."launch_events" ("id"),
  "ordinal" integer NOT NULL,
  "from_status" text NOT NULL,
  "to_status" text NOT NULL,
  "actor_id" text NOT NULL,
  "approver_id" text NOT NULL,
  "at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("event_id", "ordinal")
);

-- Holdings at the snapshot: one row per account with active stake, written once in the move to snapshot.
CREATE TABLE IF NOT EXISTS "token"."launch_snapshots" (
  "event_id" text NOT NULL REFERENCES "token"."launch_events" ("id"),
  "user_id" text NOT NULL,
  "basis" numeric(38, 18) NOT NULL,
  "taken_at" timestamptz NOT NULL,
  PRIMARY KEY ("event_id", "user_id"),
  CONSTRAINT "launch_snapshots_basis_ck" CHECK ("basis" > 0)
);

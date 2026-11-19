-- Customer-entered basis for a lot that has none, and manual positions held apart from balances.
-- Reversal: 0000_basis_override.down.sql
--
-- The tax schema is created by the database bootstrap. This role does not create schemas.
-- Rows are append-only. A change is the next version. A removal is a tombstone of the next version.
-- Nothing here is a balance.

CREATE TABLE IF NOT EXISTS tax.basis_overrides (
  user_id text NOT NULL,
  lot_id text NOT NULL,
  version integer NOT NULL,
  kind text NOT NULL,
  price_per_unit text,
  acquired_at timestamptz,
  source_note text,
  asset_id text,
  qty text,
  business_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT basis_overrides_pk PRIMARY KEY (user_id, lot_id, version),
  CONSTRAINT basis_overrides_key_uq UNIQUE (business_key),
  CONSTRAINT basis_overrides_version_ck CHECK (version >= 1),
  CONSTRAINT basis_overrides_kind_ck CHECK (kind IN ('override', 'manual', 'tombstone')),
  CONSTRAINT basis_overrides_shape_ck CHECK (
    (
      kind = 'tombstone'
      AND price_per_unit IS NULL
      AND acquired_at IS NULL
      AND source_note IS NULL
      AND asset_id IS NULL
      AND qty IS NULL
    )
    OR (
      kind = 'override'
      AND price_per_unit IS NOT NULL
      AND acquired_at IS NOT NULL
      AND source_note IS NOT NULL
      AND asset_id IS NULL
      AND qty IS NULL
    )
    OR (
      kind = 'manual'
      AND price_per_unit IS NOT NULL
      AND acquired_at IS NOT NULL
      AND source_note IS NOT NULL
      AND asset_id IS NOT NULL
      AND qty IS NOT NULL
    )
  )
);

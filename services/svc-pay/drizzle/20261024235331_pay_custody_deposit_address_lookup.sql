-- W-withdraw-14 (J-wallet-07 #3-#5): a withdrawal asks whether its address is an account's deposit address on the platform,
-- by the address alone (any network). The unique index leads with the network, so this one serves that lookup. NO BALANCE LIVES HERE.
-- Reversal: 20261024235331_pay_custody_deposit_address_lookup.down.sql
CREATE INDEX IF NOT EXISTS "custody_deposit_addresses_address_lookup_idx"
  ON "pay"."custody_deposit_addresses" (lower("address"));

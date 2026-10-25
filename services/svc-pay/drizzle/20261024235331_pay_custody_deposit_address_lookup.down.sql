-- Reverses the address lookup index. Nothing else depends on it; the lookup still works, by a scan.
DROP INDEX IF EXISTS "pay"."custody_deposit_addresses_address_lookup_idx";

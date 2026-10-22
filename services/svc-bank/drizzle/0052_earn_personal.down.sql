-- intafaced:destructive drops earn withdraw history, pool availability rules, auto programs and settings commands.
-- Drain or finish every `deallocating` position before running this. The 'deallocating' enum value stays: Postgres
-- cannot drop an enum value safely (same as 0001).
DROP TABLE IF EXISTS "bank"."earn_settings_commands";
DROP TABLE IF EXISTS "bank"."earn_auto_programs";
DROP TABLE IF EXISTS "bank"."earn_pool_availability";
DROP TABLE IF EXISTS "bank"."earn_withdrawals";

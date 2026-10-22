-- intafaced:destructive — reversal of 0001_explorer_block_facts.sql
-- Strands nothing: every row is derived from chain state and rebuilt by re-indexing.
DROP TABLE IF EXISTS "indexer"."explorer_block_facts";

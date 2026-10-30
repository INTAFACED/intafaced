-- Reverse 20261029210000_algo_pov_basis.sql
ALTER TABLE "trade"."algo_parents" DROP CONSTRAINT IF EXISTS "algo_parents_pov_basis_ck";
ALTER TABLE "trade"."algo_parents" DROP COLUMN IF EXISTS "pov_basis";

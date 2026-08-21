-- The pricing pivot: the ₹99 product stops being a 7-day tier and becomes a
-- permanent unlock of ONE company target. Two nullable columns, no data moves:
--
--   targets.unlocked_at — set when the purchase for that target settles;
--   tailored runs against a locked target are refused for non-pass accounts.
--   orders.target_id    — which target a pack1 order pays for, recorded at
--   checkout so the grant path never trusts the confirmation request.
--
-- Existing rows are all correct with NULL: no target sold under the old model
-- maps to a specific unlock (the old pack granted a tier on the user), and old
-- orders bought plans, not targets. Accounts still inside an old 7-day pack
-- tier keep working through the legacy plan path until they expire.

ALTER TABLE "targets" ADD COLUMN "unlocked_at" TIMESTAMP(3);
ALTER TABLE "orders" ADD COLUMN "target_id" TEXT;

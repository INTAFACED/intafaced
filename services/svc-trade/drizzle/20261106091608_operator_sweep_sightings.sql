-- J-cex-spot-18 #3: the operator reconcile sweep releases a hold only on its SECOND sighting of the order's engine miss,
-- at least the owner's age floor after the first. A fill the engine made reaches trade.fills late (on the bus), so one
-- look at an empty book and an empty trade.fills is not proof the order never filled; two looks a floor apart are.
-- One row per order: when a sweep first saw it missing from the book, and which sweep.
CREATE TABLE IF NOT EXISTS trade.operator_sweep_sightings (
  order_id uuid PRIMARY KEY REFERENCES trade.orders (id),
  first_seen_at timestamptz NOT NULL,
  sweep_request_id text NOT NULL
);

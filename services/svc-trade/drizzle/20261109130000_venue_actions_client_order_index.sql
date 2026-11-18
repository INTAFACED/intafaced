-- J-derivatives-17 #4: the routed-volume recon looks up the orders we prepared by the venue's client order id. Without
-- this index each read scans every action prepared on the venue.
CREATE INDEX IF NOT EXISTS user_venue_actions_client_order
  ON trade.user_venue_actions (venue_id, (prepared->>'venueClientOrderId'))
  WHERE kind = 'place_order';

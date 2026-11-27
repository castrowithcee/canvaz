-- When an operator lifted a block early. The failure counter of that address restarts from there, so one
-- more failure does not block again at once; `created_at` stays as history for the 30-day proposal rule.
-- A new block for the address clears it.

alter table sender_block add column lifted_at timestamptz;

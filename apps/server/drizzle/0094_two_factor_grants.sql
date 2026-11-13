-- Global, as the operator is. The app sets it up, checks codes, turns it off, and lists who has it
-- on in Settings > Team. An account's delete removes the row.
GRANT SELECT, INSERT, UPDATE, DELETE ON operator_two_factor TO dinghy_app;

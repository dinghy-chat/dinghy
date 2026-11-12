-- The operator app shows which replies an email carried, and an edit checks whether one is sending.
GRANT SELECT (covered_from_seq, covered_to_seq) ON alert_delivery TO dinghy_app;

-- An owner, an admin or a Setup key replays a delivery: the app inserts its new row, under the
-- tenant policy that already covers dinghy_app.
GRANT INSERT ON webhook_delivery TO dinghy_app;

-- Global: it describes the server, not a workspace. The worker writes it, and the app reads it for
-- /readyz and /metrics.
GRANT SELECT, INSERT, UPDATE ON worker_heartbeat TO dinghy_worker;
--> statement-breakpoint
GRANT SELECT ON worker_heartbeat TO dinghy_app;

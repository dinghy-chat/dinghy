-- The worker records a billing change on the workspace's event feed when it makes a workspace
-- read-only, in its own context only, through the tenant policies.
GRANT INSERT ON event TO dinghy_worker;
--> statement-breakpoint
GRANT UPDATE (event_seq) ON workspace TO dinghy_worker;

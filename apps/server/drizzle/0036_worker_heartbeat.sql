CREATE TABLE "worker_heartbeat" (
	"id" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"passed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "worker_heartbeat_one_row" CHECK ("worker_heartbeat"."id")
);

-- "Agent" read like an AI agent, so the role is now "member".
ALTER TYPE "public"."member_role" RENAME VALUE 'agent' TO 'member';

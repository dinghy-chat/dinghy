-- The worker signals each workspace of an account when a removal request's first warning moves its
-- end and when the request completes, so the Team pages and the account's open apps read again.
-- It already looks across workspaces for this feature with operator_managers.
GRANT EXECUTE ON FUNCTION operator_workspaces(uuid) TO dinghy_worker;

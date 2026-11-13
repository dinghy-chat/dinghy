-- A request that only the account's own mailbox could hear of goes to manual review: the worker
-- ends it before its wait begins.
GRANT DELETE ON two_factor_removal TO dinghy_worker;

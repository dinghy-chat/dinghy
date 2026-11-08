-- Global, so they need no workspace context. The worker role has no reason to read passwords.
GRANT SELECT, INSERT, UPDATE, DELETE ON session, account, verification TO dinghy_app;

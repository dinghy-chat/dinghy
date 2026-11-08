-- Global, like the auth tables, because it describes the server and holds nothing secret.
GRANT SELECT, INSERT, UPDATE ON instance_setting TO dinghy_app;

-- The install email asks whether the widget has loaded on a site, so the worker reads the sites the
-- widget recorded. The tenant policy already names the worker.
GRANT SELECT ON widget_site_seen TO dinghy_worker;

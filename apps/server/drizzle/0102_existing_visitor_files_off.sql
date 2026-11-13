-- Visitors' files came on by default in 0095. Widgets made before this upgrade keep them off, so no
-- visitor starts sending files without the owner choosing it. New widgets keep the column's default.
UPDATE widget_settings SET visitor_files = false;

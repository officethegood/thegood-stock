-- supabase/migrations/20260518000600_rls_policies.sql

ALTER TABLE locations         ENABLE ROW LEVEL SECURITY;
ALTER TABLE ambulances        ENABLE ROW LEVEL SECURITY;
ALTER TABLE settings          ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_log  ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_sessions     ENABLE ROW LEVEL SECURITY;

-- locations
CREATE POLICY loc_read  ON locations FOR SELECT TO authenticated USING (true);
CREATE POLICY loc_write ON locations FOR ALL    TO authenticated
  USING (app_user_role() = 'Admin') WITH CHECK (app_user_role() = 'Admin');

-- ambulances
CREATE POLICY amb_read  ON ambulances FOR SELECT TO authenticated USING (true);
CREATE POLICY amb_write ON ambulances FOR ALL    TO authenticated
  USING (app_user_role() = 'Admin') WITH CHECK (app_user_role() = 'Admin');

-- settings
CREATE POLICY set_read  ON settings FOR SELECT TO authenticated USING (true);
CREATE POLICY set_write ON settings FOR ALL    TO authenticated
  USING (app_user_role() = 'Admin') WITH CHECK (app_user_role() = 'Admin');

-- notification_log
CREATE POLICY nlog_read ON notification_log FOR SELECT TO authenticated USING (true);

-- user_sessions
CREATE POLICY sess_select ON user_sessions FOR SELECT TO authenticated
  USING (username = app_username() OR app_user_role() = 'Admin');
CREATE POLICY sess_revoke ON user_sessions FOR UPDATE TO authenticated
  USING (app_user_role() = 'Admin') WITH CHECK (app_user_role() = 'Admin');

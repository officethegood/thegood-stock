-- supabase/migrations/20260705010000_bag_deploy_return.sql
-- Feature — กระเป๋าขึ้นรถ / คืนกระเป๋า (bag deploy & return, no due date).
--
-- A bag is a locations row (type='bag') whose contents live "inside" it via
-- the location hierarchy, so taking a bag onto an ambulance = re-parenting
-- the bag location under the ambulance. Until now only an Admin could do
-- that through the locations form, with no record of who took which bag
-- where. This migration adds:
--
--   1. bag_moves       — audit log (who moved which bag where, when)
--   2. rpc_deploy_bag  — staff-callable: bag → ambulance (records the bag's
--                        current parent as "home" so return is automatic)
--   3. rpc_return_bag  — staff-callable: bag → back to the home parent
--                        recorded by the most recent deploy
--   4. Telegram notify — AFTER INSERT on bag_moves, same fail-soft pattern
--                        as notify_stock_movement_to_tg (20260525000000)
--
-- Design decisions (PM Pex 2026-07-05):
--   • NO due date / overdue tracking — this is a "temporary re-homing",
--     not a loan. Admin sees where every bag is from the locations tree.
--   • Any authenticated role (Admin + Employee) may deploy/return.
--   • Deploy destination must be an active type='ambulance' location.
--
-- Depends on: locations (Phase 0), app_user_role()/app_username() helpers,
--             settings + pg_net + tg-notify chain (20260525000000 pattern).
-- Idempotent: CREATE TABLE IF NOT EXISTS, CREATE OR REPLACE FUNCTION,
--             DROP TRIGGER IF EXISTS, DROP POLICY IF EXISTS.

-- ==========================================================================
-- 1. bag_moves audit table
-- ==========================================================================

CREATE TABLE IF NOT EXISTS bag_moves (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  bag_location_id  uuid        NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  action           text        NOT NULL CHECK (action IN ('deploy', 'return')),
  from_parent_id   uuid        REFERENCES locations(id) ON DELETE SET NULL,
  to_parent_id     uuid        REFERENCES locations(id) ON DELETE SET NULL,
  moved_by         text        NOT NULL DEFAULT app_username(),
  moved_at         timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE bag_moves IS
  'กระเป๋าขึ้นรถ/คืน audit log. One row per deploy/return. from_parent_id of the '
  'latest deploy row is the bag''s "home" that rpc_return_bag restores.';

CREATE INDEX IF NOT EXISTS idx_bag_moves_bag ON bag_moves(bag_location_id, moved_at DESC);

ALTER TABLE bag_moves ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS bag_moves_read ON bag_moves;
CREATE POLICY bag_moves_read ON bag_moves
  FOR SELECT TO authenticated USING (true);
-- No INSERT/UPDATE/DELETE policies: writes happen only inside the
-- SECURITY DEFINER RPCs below.

-- ==========================================================================
-- 2. rpc_deploy_bag — bag → ambulance
-- ==========================================================================

CREATE OR REPLACE FUNCTION rpc_deploy_bag(
  p_bag_id  uuid,
  p_dest_id uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $rpc_deploy_bag$
DECLARE
  v_bag  locations;
  v_dest locations;
BEGIN
  IF app_user_role() NOT IN ('Admin', 'Employee') THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์ดำเนินการ';
  END IF;

  SELECT * INTO v_bag FROM locations WHERE id = p_bag_id FOR UPDATE;
  IF NOT FOUND OR v_bag.type <> 'bag' OR v_bag.active IS NOT TRUE THEN
    RAISE EXCEPTION 'ไม่พบกระเป๋า หรือรายการนี้ไม่ใช่กระเป๋า';
  END IF;

  SELECT * INTO v_dest FROM locations WHERE id = p_dest_id;
  IF NOT FOUND OR v_dest.active IS NOT TRUE THEN
    RAISE EXCEPTION 'ไม่พบรถปลายทาง';
  END IF;
  IF v_dest.type <> 'ambulance' THEN
    RAISE EXCEPTION 'ปลายทางต้องเป็นรถพยาบาล';
  END IF;
  IF v_dest.id = v_bag.id THEN
    RAISE EXCEPTION 'ปลายทางไม่ถูกต้อง';
  END IF;
  IF v_bag.parent_id = v_dest.id THEN
    RAISE EXCEPTION 'กระเป๋าอยู่บนรถคันนี้อยู่แล้ว';
  END IF;

  UPDATE locations SET parent_id = p_dest_id WHERE id = p_bag_id;

  INSERT INTO bag_moves (bag_location_id, action, from_parent_id, to_parent_id)
  VALUES (p_bag_id, 'deploy', v_bag.parent_id, p_dest_id);

  RETURN jsonb_build_object(
    'ok', true,
    'bag_code',  v_bag.code,
    'dest_name', v_dest.name
  );
END;
$rpc_deploy_bag$;

COMMENT ON FUNCTION rpc_deploy_bag(uuid, uuid) IS
  'กระเป๋าขึ้นรถ: re-parents a type=bag location under an active ambulance '
  'location and logs a bag_moves deploy row (from_parent_id = home for the '
  'matching return). Admin + Employee. SECURITY DEFINER.';

REVOKE ALL ON FUNCTION rpc_deploy_bag(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rpc_deploy_bag(uuid, uuid) TO authenticated;

-- ==========================================================================
-- 3. rpc_return_bag — bag → home recorded by the latest deploy
-- ==========================================================================

CREATE OR REPLACE FUNCTION rpc_return_bag(
  p_bag_id uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $rpc_return_bag$
DECLARE
  v_bag       locations;
  v_home_id   uuid;
  v_home_name text;
BEGIN
  IF app_user_role() NOT IN ('Admin', 'Employee') THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์ดำเนินการ';
  END IF;

  SELECT * INTO v_bag FROM locations WHERE id = p_bag_id FOR UPDATE;
  IF NOT FOUND OR v_bag.type <> 'bag' THEN
    RAISE EXCEPTION 'ไม่พบกระเป๋า';
  END IF;

  SELECT from_parent_id INTO v_home_id
  FROM bag_moves
  WHERE bag_location_id = p_bag_id AND action = 'deploy'
  ORDER BY moved_at DESC
  LIMIT 1;

  IF v_home_id IS NULL THEN
    RAISE EXCEPTION 'ไม่พบประวัติการนำกระเป๋าขึ้นรถ — แจ้ง Admin ให้ย้ายในหน้าสถานที่';
  END IF;
  IF v_bag.parent_id = v_home_id THEN
    RAISE EXCEPTION 'กระเป๋าอยู่ที่เก็บเดิมอยู่แล้ว';
  END IF;

  SELECT name INTO v_home_name FROM locations WHERE id = v_home_id;

  UPDATE locations SET parent_id = v_home_id WHERE id = p_bag_id;

  INSERT INTO bag_moves (bag_location_id, action, from_parent_id, to_parent_id)
  VALUES (p_bag_id, 'return', v_bag.parent_id, v_home_id);

  RETURN jsonb_build_object(
    'ok', true,
    'bag_code',  v_bag.code,
    'home_name', COALESCE(v_home_name, '')
  );
END;
$rpc_return_bag$;

COMMENT ON FUNCTION rpc_return_bag(uuid) IS
  'คืนกระเป๋า: re-parents the bag back to the from_parent_id recorded by its '
  'most recent bag_moves deploy row. Admin + Employee. SECURITY DEFINER.';

REVOKE ALL ON FUNCTION rpc_return_bag(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rpc_return_bag(uuid) TO authenticated;

-- ==========================================================================
-- 4. Telegram notify — same fail-soft pattern as 20260525000000
-- ==========================================================================

CREATE OR REPLACE FUNCTION notify_bag_move_to_tg()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, net
AS $notify_bag_move$
DECLARE
  v_enabled          boolean;
  v_chat_id          text;
  v_supabase_url     text;
  v_service_role_key text;
  v_bag_code         text;
  v_bag_name         text;
  v_dest_name        text;
  v_message          text;
  v_payload          jsonb;
BEGIN
  BEGIN
    SELECT (value = 'true') INTO v_enabled
      FROM settings WHERE key = 'NOTIFY_TELEGRAM_ENABLED';
    IF v_enabled IS NOT TRUE THEN RETURN NEW; END IF;

    SELECT value INTO v_chat_id          FROM settings WHERE key = 'NOTIFY_TELEGRAM_CHAT_ID';
    SELECT value INTO v_supabase_url     FROM settings WHERE key = 'NOTIFY_SUPABASE_URL';
    SELECT value INTO v_service_role_key FROM settings WHERE key = 'NOTIFY_SERVICE_ROLE_KEY';

    IF v_chat_id          IS NULL OR v_chat_id          = '' THEN RETURN NEW; END IF;
    IF v_supabase_url     IS NULL OR v_supabase_url     = '' THEN RETURN NEW; END IF;
    IF v_service_role_key IS NULL OR v_service_role_key = '' THEN RETURN NEW; END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'notify_bag_move: settings read failed: %', SQLERRM;
    RETURN NEW;
  END;

  BEGIN
    SELECT code, name INTO v_bag_code, v_bag_name
      FROM locations WHERE id = NEW.bag_location_id;
    SELECT name INTO v_dest_name
      FROM locations WHERE id = NEW.to_parent_id;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'notify_bag_move: name lookup failed: %', SQLERRM;
  END;

  IF NEW.action = 'deploy' THEN
    v_message := format(U&'\1F691' || ' กระเป๋าขึ้นรถ · %s %s → %s · %s',
      COALESCE(v_bag_code, '?'), COALESCE(v_bag_name, ''),
      COALESCE(v_dest_name, '?'), COALESCE(NEW.moved_by, '?'));
  ELSE
    v_message := format(U&'\21A9' || ' คืนกระเป๋า · %s %s → %s · %s',
      COALESCE(v_bag_code, '?'), COALESCE(v_bag_name, ''),
      COALESCE(v_dest_name, '?'), COALESCE(NEW.moved_by, '?'));
  END IF;

  v_payload := jsonb_build_object(
    'event_type',  'bag_move',
    'entity_type', 'bag_move',
    'entity_id',   NEW.id::text,
    'dedupe_key',  'bm:' || NEW.id::text,
    'message',     v_message,
    'chat_id',     v_chat_id
  );

  BEGIN
    PERFORM net.http_post(
      url     := v_supabase_url || '/functions/v1/tg-notify',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || v_service_role_key,
        'apikey',        v_service_role_key,
        'X-Internal',    'true'
      ),
      body    := v_payload
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'notify_bag_move: pg_net.http_post failed: %', SQLERRM;
  END;

  RETURN NEW;
END;
$notify_bag_move$;

COMMENT ON FUNCTION notify_bag_move_to_tg() IS
  'AFTER INSERT on bag_moves. Posts a one-line Thai Telegram message per '
  'deploy/return via tg-notify. Fail-soft: never blocks the move.';

DROP TRIGGER IF EXISTS trg_bag_moves_notify_tg ON bag_moves;
CREATE TRIGGER trg_bag_moves_notify_tg
  AFTER INSERT ON bag_moves
  FOR EACH ROW EXECUTE FUNCTION notify_bag_move_to_tg();

-- ==========================================================================
-- Verification SQL (paste in Dashboard SQL Editor after applying)
-- ==========================================================================
-- A) Table + policies:
--    SELECT tablename, policyname FROM pg_policies WHERE tablename='bag_moves';
--    Expected: bag_moves_read
--
-- B) Functions present, SECURITY DEFINER:
--    SELECT proname, prosecdef FROM pg_proc
--    WHERE proname IN ('rpc_deploy_bag','rpc_return_bag','notify_bag_move_to_tg');
--    Expected: 3 rows, all prosecdef = true
--
-- C) End-to-end: staff scans a bag QR → กดปุ่ม "เอาขึ้นรถ" → pick a vehicle.
--    Expected: bag's parent changes to the ambulance in the locations tree,
--    a bag_moves row appears, and a Telegram message arrives. Then กด
--    "คืนกระเป๋า" → parent returns to the original home.

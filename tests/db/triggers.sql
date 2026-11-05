-- Bind the real functions (loaded from migrations) as production does.
-- Names match prod so BEFORE-trigger firing order (alphabetical) is the same.
CREATE TRIGGER trg_check_lot_status BEFORE INSERT ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION check_lot_status();
CREATE TRIGGER trg_lot_qty_apply AFTER INSERT ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION apply_movement_to_lot_qty();
CREATE TRIGGER trg_sm_apply AFTER INSERT ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION apply_movement_to_sil();

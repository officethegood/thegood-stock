#!/usr/bin/env bash
# Runs the stock DB regression tests on a THROWAWAY local Postgres cluster.
# Never connects to Supabase. Needs initdb/pg_ctl/psql (set PG_BIN if not on PATH).
#   bash tests/db/run.sh
set -euo pipefail
export PGCLIENTENCODING=UTF8   # migrations contain Thai; psql may default to WIN1252 on Windows

HERE="$(cd "$(dirname "$0")" && pwd)"
M="$HERE/../../supabase/migrations"
BIN="${PG_BIN:-/c/Program Files/PostgreSQL/17/bin}"
PORT="${PG_TEST_PORT:-55433}"
DATA="$(mktemp -d)/pg"

cleanup() {
  "$BIN/pg_ctl" -D "$DATA" stop -m fast >/dev/null 2>&1 || true
  rm -rf "$(dirname "$DATA")"
}
trap cleanup EXIT

"$BIN/initdb" -D "$DATA" -U postgres -A trust -E UTF8 --locale=C >/dev/null
# Linux default socket dir (/var/run/postgresql) is not writable on CI runners.
SOCK=""
[ "$(uname -s)" = "Linux" ] && SOCK="-k $(dirname "$DATA")"
"$BIN/pg_ctl" -D "$DATA" -o "-p $PORT $SOCK" -l "$DATA.log" -w start >/dev/null \
  || { cat "$DATA.log"; exit 1; }

run() { "$BIN/psql" -h localhost -p "$PORT" -U postgres -d postgres -v ON_ERROR_STOP=1 -q -f "$1"; }

run "$HERE/schema_stub.sql"
# REAL function bodies, in the order production applied them, so the latest definition
# of each wins. A new CREATE OR REPLACE of a stock trigger/RPC must be added here.
for f in \
  20260519030100_stock_loans \
  20260519030300_borrow_return_triggers \
  20260703010000_lot_reactivate_on_gain \
  20260709010000_borrow_lot_support \
  20260712010000_fix_sil_lot_double_apply \
  20260715031000_harden_return_lifecycle \
  20260715034000_check_lot_status_item_match_and_expired_reason
do run "$M/$f.sql"; done
run "$HERE/triggers.sql"
for f in \
  20260519070500_rpc_transfer_stock \
  20260703010100_rpc_recall_lot_cap_sil \
  20260519050000_oxygen_tank_status_enum \
  20260519050200_oxygen_tanks \
  20260519050300_oxygen_movements \
  20260519050500_oxygen_triggers \
  20260519050700_tighten_oxygen_triggers_search_path \
  20260521040000_fix_oxygen_state_machine_initial \
  20260521050000_fix_oxygen_refill_pgnet \
  20260525010000_notify_oxygen_movement \
  20260529010000_oxygen_awaiting_refill_enum \
  20260529010100_oxygen_awaiting_refill_logic \
  20260530010000_notify_location_name \
  20260715021000_lock_oxygen_state_transition \
  20260715050000_bag_subtree_contents \
  20261015020000_v_bag_lot_contents \
  20261026010000_v_bag_status_precise_expiry \
  20261105010000_guard_lot_at_location \
  20261105020000_stock_audit_alert \
  20261105030000_bag_status_expiry_before_template \
  20261105040000_harden_movement_writes \
  20261105050000_atomic_stock_rpcs \
  20261106010000_bag_template_save_and_empty_status \
  20261109010000_return_targets_selected_loan \
  20261109020000_delete_location_keeps_history \
  20261109030000_clear_location_refuses_drift \
  20261109040000_lowstock_skip_transfer \
  20261109050000_rpc_restock_bag
do run "$M/$f.sql" >/dev/null; done

run "$HERE/lot_location_test.sql"
run "$HERE/audit_test.sql"
run "$HERE/hardening_test.sql"
run "$HERE/review_fixes_test.sql"

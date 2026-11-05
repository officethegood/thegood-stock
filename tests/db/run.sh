#!/usr/bin/env bash
# Runs the stock DB regression tests on a THROWAWAY local Postgres cluster.
# Never connects to Supabase. Needs initdb/pg_ctl/psql (set PG_BIN if not on PATH).
#   bash tests/db/run.sh
set -euo pipefail

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
"$BIN/pg_ctl" -D "$DATA" -o "-p $PORT" -w start >/dev/null

run() { "$BIN/psql" -h localhost -p "$PORT" -U postgres -d postgres -v ON_ERROR_STOP=1 -q -f "$1"; }

run "$HERE/schema_stub.sql"
# REAL function bodies: the chronologically latest definition of each.
run "$M/20260703010000_lot_reactivate_on_gain.sql"           # apply_movement_to_lot_qty
run "$M/20260712010000_fix_sil_lot_double_apply.sql"         # apply_movement_to_sil
run "$M/20260715034000_check_lot_status_item_match_and_expired_reason.sql"
run "$HERE/triggers.sql"
run "$M/20260519070500_rpc_transfer_stock.sql"
run "$M/20260703010100_rpc_recall_lot_cap_sil.sql"
run "$M/20261105010000_guard_lot_at_location.sql"
run "$HERE/lot_location_test.sql"

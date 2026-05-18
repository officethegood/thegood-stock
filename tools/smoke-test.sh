#!/usr/bin/env bash
# tools/smoke-test.sh — basic post-deploy checks.
# Usage: PROJECT_REF=xxx ANON_KEY=xxx ./tools/smoke-test.sh

set -u

PROJECT_REF="${PROJECT_REF:-}"
ANON_KEY="${ANON_KEY:-}"
GAS_HR="${GAS_HR:-https://script.google.com/macros/s/AKfycbxV5tbmeFx8SxEENtFgHNhZJfM26QocQX1bfqSzxxOPFd_CSiRCINGE2FfXuRAVF-IYGw/exec}"
WORKER="${WORKER:-https://thegood-ocr-proxy.officethegood.workers.dev}"

if [ -z "$PROJECT_REF" ] || [ -z "$ANON_KEY" ]; then
  echo "Usage: PROJECT_REF=... ANON_KEY=... $0"
  exit 1
fi

echo "1. auth-bridge unknown action"
curl -sS -X POST "https://$PROJECT_REF.supabase.co/functions/v1/auth-bridge" \
  -H "Authorization: Bearer $ANON_KEY" -H "Content-Type: application/json" \
  -d '{}' | head -c 200; echo

echo "2. GAS HR shape"
curl -sS -X POST "$GAS_HR" -H "Content-Type: text/plain" \
  -d '{"username":"nobody","password":"x"}' | head -c 200; echo

echo "3. Worker health"
curl -sS "$WORKER/notify/health" | head -c 200; echo

echo "4. settings count"
curl -sS "https://$PROJECT_REF.supabase.co/rest/v1/settings?select=key" \
  -H "apikey: $ANON_KEY" -H "Authorization: Bearer $ANON_KEY" \
  | python -c "import sys,json; print('rows:', len(json.load(sys.stdin)))"

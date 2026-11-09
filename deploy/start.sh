#!/bin/bash
set -euo pipefail

cd /app/backend
for attempt in {1..30}; do
  if ./node_modules/.bin/prisma migrate deploy; then
    break
  fi
  if [ "$attempt" -eq 30 ]; then
    echo "Database migrations did not complete after 30 attempts" >&2
    exit 1
  fi
  sleep 2
done
cd /app
nginx -c /etc/nginx/nginx.conf -g 'daemon off;' &
nginx_pid=$!
node --import ./backend/dist/platform/telemetry/instrumentation.js ./backend/dist/server.js &
backend_pid=$!
trap 'kill "$nginx_pid" "$backend_pid" 2>/dev/null || true' INT TERM EXIT
wait -n "$nginx_pid" "$backend_pid"

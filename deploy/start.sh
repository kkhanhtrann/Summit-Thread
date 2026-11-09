#!/bin/bash
set -euo pipefail

cd /app/backend
./node_modules/.bin/prisma migrate deploy
cd /app
nginx -c /etc/nginx/nginx.conf -g 'daemon off;' &
nginx_pid=$!
node --import ./backend/dist/platform/telemetry/instrumentation.js ./backend/dist/server.js &
backend_pid=$!
trap 'kill "$nginx_pid" "$backend_pid" 2>/dev/null || true' INT TERM EXIT
wait -n "$nginx_pid" "$backend_pid"

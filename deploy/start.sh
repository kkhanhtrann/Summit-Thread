#!/bin/sh
set -eu

cd /app
./backend/node_modules/.bin/prisma db push --skip-generate
nginx -c /etc/nginx/nginx.conf
nginx_pid="$(cat /tmp/nginx.pid)"
node --import ./backend/dist/platform/telemetry/instrumentation.js ./backend/dist/server.js &
backend_pid=$!
trap 'kill "$nginx_pid" "$backend_pid" 2>/dev/null || true' INT TERM EXIT
wait -n "$nginx_pid" "$backend_pid"

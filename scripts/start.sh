#!/bin/sh
set -eu

export HOST="${HOST:-0.0.0.0}"
export PORT="${PORT:-3000}"

echo "[start] HOST=$HOST PORT=$PORT"
echo "[start] cwd=$(pwd)"
ls -la build/server 2>/dev/null || echo "[start] WARNING: build/server missing"

# Sessions DB (SQLite). Do not block the web server if migrate fails —
# otherwise Railway returns "Application failed to respond".
if ! npx prisma migrate deploy; then
  echo "[start] WARNING: prisma migrate deploy failed — continuing"
fi

echo "[start] launching react-router-serve on ${HOST}:${PORT}"
exec npx react-router-serve ./build/server/index.js

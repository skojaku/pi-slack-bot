#!/bin/bash
set -e

echo "[entrypoint] Starting cron daemon..."
service cron start

echo "[entrypoint] Starting pi-slack-bot..."
exec node --import tsx/esm src/index.ts

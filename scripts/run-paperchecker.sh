#!/bin/bash
set -euo pipefail

PAPERCHECKER_DIR="/app/paperchecker"
VENV_DIR="$PAPERCHECKER_DIR/.venv"
MAX_TRIES=10

echo "[$(date)] === paperchecker run starting ==="

# Allow git operations in any directory (needed for deploy_pages.sh in Docker)
git config --global --add safe.directory '*'

# Create venv if needed and install/update dependencies
echo "[$(date)] Installing Python dependencies..."
[ -d "$VENV_DIR" ] || uv venv "$VENV_DIR"
uv pip install -r "$PAPERCHECKER_DIR/requirements.txt" --python "$VENV_DIR/bin/python" --quiet

# Load paperchecker env vars (.env holds Discord token, etc.)
set -a
# shellcheck source=/dev/null
[ -f "$PAPERCHECKER_DIR/.env" ] && source "$PAPERCHECKER_DIR/.env"
set +a

cd "$PAPERCHECKER_DIR"
# shellcheck source=/dev/null
source "$VENV_DIR/bin/activate"

for i in $(seq 1 $MAX_TRIES); do
    echo "[$(date)] Attempt $i/$MAX_TRIES..."
    if snakemake --cores 1; then
        echo "[$(date)] Success on attempt $i"
        exit 0
    fi
    echo "[$(date)] Attempt $i failed"
    [ "$i" -lt "$MAX_TRIES" ] && sleep 60
done

echo "[$(date)] All $MAX_TRIES attempts failed"
exit 1

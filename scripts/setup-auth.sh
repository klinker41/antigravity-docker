#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$SCRIPT_DIR"

echo "==================================================================="
echo "  Google Antigravity Remote Control - Initial Authentication"
echo "==================================================================="
echo ""
echo "This will start an interactive session to authenticate with Google."
echo "1. A sign-in URL will appear on your screen."
echo "2. Open the URL on your phone or laptop browser."
echo "3. Grant access to your Google Account."
echo "4. Your OAuth token will be persisted to ./data/gemini."
echo ""
echo "Press Ctrl+C at any time to cancel."
echo "-------------------------------------------------------------------"

# Ensure data directory exists
mkdir -p ./data/gemini ./data/antigravity ./workspace

# Load .env if present
if [ -f .env ]; then
    set -a
    source .env
    set +a
fi

INSTANCE_NAME="${RC_NAME:-my-server-agent}"
WORKSPACE_PATH="${WORKSPACE_DIR:-${SCRIPT_DIR}/workspace}"

# Detect Docker Compose command (docker compose v2 vs docker-compose v1 vs direct docker run)
if docker compose version >/dev/null 2>&1; then
    docker compose run --rm antigravity-agent setup
elif command -v docker-compose >/dev/null 2>&1; then
    docker-compose run --rm antigravity-agent setup
else
    echo "Notice: docker-compose not detected. Using direct 'docker run'..."
    docker run -it --rm \
        -v /var/run/docker.sock:/var/run/docker.sock \
        -v "${SCRIPT_DIR}/data/gemini:/home/developer/.gemini" \
        -v "${SCRIPT_DIR}/data/antigravity:/home/developer/.antigravity" \
        -v "${WORKSPACE_PATH}:/workspace" \
        -e RC_NAME="${INSTANCE_NAME}" \
        jklinker/antigravity-docker:latest setup
fi

echo ""
echo "==================================================================="
echo "✓ Authentication completed successfully!"
echo "Now you can start the background daemon with:"
echo "  docker compose up -d"
echo "==================================================================="

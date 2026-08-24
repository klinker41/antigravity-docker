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

# Run interactive setup container
docker compose run --rm antigravity-agent setup

echo ""
echo "==================================================================="
echo "✓ Authentication completed successfully!"
echo "Now you can start the background daemon with:"
echo "  docker compose up -d"
echo "==================================================================="

#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$SCRIPT_DIR"

echo "==================================================================="
echo "  Testing Container Environment & Host Docker Connectivity"
echo "==================================================================="

docker compose run --rm antigravity-agent bash -c '
    echo "--- 1. Base OS ---"
    cat /etc/os-release | grep PRETTY_NAME

    echo ""
    echo "--- 2. Python Environment ---"
    python3 --version
    pip --version
    uv --version
    poetry --version

    echo ""
    echo "--- 3. Node.js Environment (Node 26) ---"
    node --version
    npm --version
    pnpm --version
    yarn --version
    bun --version

    echo ""
    echo "--- 4. Antigravity CLI ---"
    agy --version || true

    echo ""
    echo "--- 5. Host Docker Access via /var/run/docker.sock ---"
    docker --version
    docker compose version
    echo "Checking host containers list:"
    docker ps --format "table {{.ID}}\t{{.Image}}\t{{.Status}}\t{{.Names}}"

    echo ""
    echo "--- 6. Testing Spawn of Sub-container on Host ---"
    docker run --rm hello-world | grep "Hello from Docker!" && echo "✓ Successfully ran container on host Docker daemon from inside Antigravity agent container!"
'

echo "==================================================================="
echo "✓ All tests passed!"
echo "==================================================================="

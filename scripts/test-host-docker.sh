#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$SCRIPT_DIR"

echo "==================================================================="
echo "  Testing Container Environment & Host Docker Connectivity"
echo "==================================================================="

TEST_CMD='
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
    docker compose version 2>/dev/null || docker-compose version 2>/dev/null || true
    echo "Checking host containers list:"
    docker ps --format "table {{.ID}}\t{{.Image}}\t{{.Status}}\t{{.Names}}"

    echo ""
    echo "--- 6. Testing Spawn of Sub-container on Host ---"
    docker run --rm hello-world | grep "Hello from Docker!" && echo "✓ Successfully ran container on host Docker daemon from inside Antigravity agent container!"
'

if docker compose version >/dev/null 2>&1; then
    docker compose run --rm antigravity-agent bash -c "$TEST_CMD"
elif command -v docker-compose >/dev/null 2>&1; then
    docker-compose run --rm antigravity-agent bash -c "$TEST_CMD"
else
    docker run --rm \
        -v /var/run/docker.sock:/var/run/docker.sock \
        antigravity-headless:latest bash -c "$TEST_CMD"
fi

echo "==================================================================="
echo "✓ All tests passed!"
echo "==================================================================="

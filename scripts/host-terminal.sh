#!/usr/bin/env bash
# Host Terminal Wrapper - Executes commands on the Host Machine via SSH

set -e

# Configuration from environment or defaults
HOST_USER="${HOST_SSH_USER:-}"
HOST_ADDR="${HOST_SSH_HOST:-host.docker.internal}"
HOST_PORT="${HOST_SSH_PORT:-22}"

# Auto-detect host username if not specified
if [ -z "$HOST_USER" ]; then
    WORKSPACE_OWNER=$(stat -c '%U' /workspace 2>/dev/null || true)
    if [ -n "$WORKSPACE_OWNER" ] && [ "$WORKSPACE_OWNER" != "root" ] && [ "$WORKSPACE_OWNER" != "developer" ] && [ "$WORKSPACE_OWNER" != "UNKNOWN" ]; then
        HOST_USER="$WORKSPACE_OWNER"
    elif [ -n "$USER" ] && [ "$USER" != "developer" ]; then
        HOST_USER="$USER"
    else
        HOST_USER="developer"
    fi
fi

# Print banner
echo -e "\033[1;34m===================================================================\033[0m"
echo -e "\033[1;36m  🚀 Google Antigravity Host Terminal Gateway\033[0m"
echo -e "\033[1;34m===================================================================\033[0m"
echo -e " Connecting to Host Machine: \033[1;32m${HOST_USER}@${HOST_ADDR}:${HOST_PORT}\033[0m"
echo -e "\033[1;34m-------------------------------------------------------------------\033[0m"

# SSH Options for interactive terminal
SSH_OPTS=(
    -t
    -o StrictHostKeyChecking=no
    -o UserKnownHostsFile=/dev/null
    -o LogLevel=ERROR
    -o ConnectTimeout=5
    -p "$HOST_PORT"
)

# Test SSH connectivity first
if ssh -q -o BatchMode=yes -o ConnectTimeout=3 "${SSH_OPTS[@]}" "${HOST_USER}@${HOST_ADDR}" exit 0 2>/dev/null; then
    echo -e " \033[1;32m✓ SSH connection established.\033[0m"
    echo -e "\033[1;34m===================================================================\033[0m"
    exec ssh "${SSH_OPTS[@]}" "${HOST_USER}@${HOST_ADDR}"
else
    # Check if ~/.ssh has keys
    KEY_COUNT=$(find /home/developer/.ssh -maxdepth 1 -name "id_*" -not -name "*.pub" 2>/dev/null | wc -l || echo 0)
    if [ "$KEY_COUNT" -eq 0 ]; then
        echo -e "\033[1;33m⚠️  No SSH private keys found in ~/.ssh\033[0m"
        echo -e " Make sure your host ~/.ssh directory is mounted in docker-compose.yml:"
        echo -e "   \033[0;37mvolumes:\033[0m"
        echo -e "     \033[0;37m- ~/.ssh:/home/developer/.ssh:ro\033[0m"
    fi
    echo -e " Attempting interactive SSH login to \033[1;37m${HOST_USER}@${HOST_ADDR}\033[0m..."
    echo -e "\033[1;34m===================================================================\033[0m"
    
    # Try interactive SSH
    ssh "${SSH_OPTS[@]}" "${HOST_USER}@${HOST_ADDR}" || {
        EXIT_CODE=$?
        echo ""
        echo -e "\033[1;31m===================================================================\033[0m"
        echo -e "\033[1;31m ❌ Failed to connect to host via SSH (exit code $EXIT_CODE)\033[0m"
        echo -e "\033[1;31m===================================================================\033[0m"
        echo -e " Troubleshooting Tips:"
        echo -e "  1. Ensure SSH server (sshd) is running on your host machine."
        echo -e "  2. Ensure 'extra_hosts: [\"host.docker.internal:host-gateway\"]' is in docker-compose.yml."
        echo -e "  3. Set 'HOST_SSH_USER=<your-username>' in docker-compose environment if needed."
        echo -e "  4. Ensure your host SSH public key is in ~/.ssh/authorized_keys on the host."
        echo ""
        read -p "Press Enter to start an internal container bash shell, or Ctrl+C to close: " _
        exec /bin/bash
    }
fi

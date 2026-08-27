#!/usr/bin/env bash
# Host Terminal Wrapper - Executes commands on the Host Machine via SSH

set -e

# Configuration from environment or defaults
HOST_USER="${HOST_SSH_USER:-}"
HOST_ADDR="${HOST_SSH_HOST:-host.docker.internal}"
HOST_PORT="${HOST_SSH_PORT:-22}"
HOST_DIR="${HOST_SSH_DIR:-}"

# Remote command to run upon login with safe path escaping
if [ -n "$HOST_DIR" ]; then
    if [[ "$HOST_DIR" =~ [[:cntrl:]] ]]; then
        echo "Error: Invalid HOST_SSH_DIR containing control characters." >&2
        exit 1
    fi
    SAFE_HOST_DIR=$(printf '%q' "$HOST_DIR")
    REMOTE_SHELL_CMD="cd ${SAFE_HOST_DIR} 2>/dev/null || true; exec \${SHELL:-/bin/bash} -l"
else
    REMOTE_SHELL_CMD="exec \${SHELL:-/bin/bash} -l"
fi

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
if [ -n "$HOST_DIR" ]; then
    echo -e " Initial Directory: \033[1;36m${HOST_DIR}\033[0m"
fi
echo -e "\033[1;34m-------------------------------------------------------------------\033[0m"

# Prepare secure runtime SSH directory to fix any read-only volume permission issues
SSH_RUNTIME_DIR=$(mktemp -d /tmp/.ssh_runtime_XXXXXX)
chmod 700 "$SSH_RUNTIME_DIR"
trap 'rm -rf "$SSH_RUNTIME_DIR"' EXIT INT TERM

IDENTITY_ARGS=()
KNOWN_HOSTS_FILE="/home/developer/.ssh/known_hosts"

if [ -d "/home/developer/.ssh" ]; then
    # Copy keys to runtime dir to guarantee strict 0600 permissions
    cp -L /home/developer/.ssh/* "$SSH_RUNTIME_DIR/" 2>/dev/null || true
    chmod 700 "$SSH_RUNTIME_DIR" 2>/dev/null || true
    chmod 600 "$SSH_RUNTIME_DIR"/* 2>/dev/null || true
    chmod 644 "$SSH_RUNTIME_DIR"/*.pub "$SSH_RUNTIME_DIR"/known_hosts 2>/dev/null || true

    for k in "$SSH_RUNTIME_DIR"/id_* "$SSH_RUNTIME_DIR"/*.pem "$SSH_RUNTIME_DIR"/*.key; do
        if [ -f "$k" ] && [[ "$k" != *.pub ]]; then
            IDENTITY_ARGS+=(-i "$k")
        fi
    done
fi

# Base SSH Options with strict host key checking accept-new
BASE_SSH_OPTS=(
    -o StrictHostKeyChecking=accept-new
    -o UserKnownHostsFile="${SSH_RUNTIME_DIR}/known_hosts"
    -p "$HOST_PORT"
    "${IDENTITY_ARGS[@]}"
)

# Test SSH key-based connectivity first (non-interactive batch mode)
if ssh -n -o BatchMode=yes -o ConnectTimeout=3 "${BASE_SSH_OPTS[@]}" "${HOST_USER}@${HOST_ADDR}" "true" 2>/dev/null; then
    echo -e " \033[1;32m✓ SSH key authentication successful!\033[0m"
    echo -e "\033[1;34m===================================================================\033[0m"
    exec ssh -t "${BASE_SSH_OPTS[@]}" "${HOST_USER}@${HOST_ADDR}" "$REMOTE_SHELL_CMD"
else
    KEY_COUNT=${#IDENTITY_ARGS[@]}
    if [ "$KEY_COUNT" -eq 0 ]; then
        echo -e "\033[1;33m⚠️  No SSH private keys found in ~/.ssh directory.\033[0m"
        echo -e " Ensure a persistent SSH volume is mounted (e.g. \033[0;37m./data/ssh:/home/developer/.ssh\033[0m)"
        echo -e " and generate a dedicated key inside the container:"
        echo -e "   \033[1;36mssh-keygen -t ed25519 -f /home/developer/.ssh/id_ed25519\033[0m"
    else
        echo -e "\033[1;33m⚠️  Key authentication failed (${KEY_COUNT} private key(s) checked).\033[0m"
        echo -e " Public key(s) currently present in container:"
        for pub in "$SSH_RUNTIME_DIR"/*.pub; do
            if [ -f "$pub" ]; then
                echo -e "   \033[1;36m$(cat "$pub")\033[0m"
            fi
        done
        echo -e " Ensure the above public key is added to the host's \033[1;37m~/.ssh/authorized_keys\033[0m"
    fi

    echo -e " Attempting interactive SSH login to \033[1;37m${HOST_USER}@${HOST_ADDR}\033[0m..."
    echo -e "\033[1;34m===================================================================\033[0m"
    
    # Try interactive SSH (password prompt will work interactively)
    ssh -t "${BASE_SSH_OPTS[@]}" "${HOST_USER}@${HOST_ADDR}" "$REMOTE_SHELL_CMD" || {
        EXIT_CODE=$?
        echo ""
        echo -e "\033[1;31m===================================================================\033[0m"
        echo -e "\033[1;31m ❌ Failed to connect to host via SSH (exit code $EXIT_CODE)\033[0m"
        echo -e "\033[1;31m===================================================================\033[0m"
        echo -e " Troubleshooting Tips:"
        echo -e "  1. Ensure SSH server (sshd) is running on ${HOST_ADDR}:${HOST_PORT}."
        echo -e "  2. Ensure the container's public key is added to ~/.ssh/authorized_keys on the host."
        echo -e "  3. Check permissions on host: chmod 700 ~/.ssh && chmod 600 ~/.ssh/authorized_keys."
        echo ""
        read -p "Press Enter to start an internal container bash shell, or Ctrl+C to close: " _
        exec /bin/bash
    }
fi

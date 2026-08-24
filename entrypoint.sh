#!/usr/bin/env bash
set -e

DEVELOPER_USER="developer"
GEMINI_DIR="/home/${DEVELOPER_USER}/.gemini"
ANTIGRAVITY_DIR="/home/${DEVELOPER_USER}/.antigravity"
TOKEN_FILE="${GEMINI_DIR}/jetski-standalone-oauth-token"
WORKSPACE_DIR="/workspace"

# 1. Handle Docker Socket GID dynamically
if [ -S /var/run/docker.sock ]; then
    DOCKER_GID=$(stat -c '%g' /var/run/docker.sock 2>/dev/null || stat -f '%g' /var/run/docker.sock 2>/dev/null || true)
    if [ -n "$DOCKER_GID" ] && [ "$DOCKER_GID" != "0" ]; then
        # Check if a group already exists with this GID
        EXISTING_GROUP=$(getent group "$DOCKER_GID" | cut -d: -f1 || true)
        if [ -n "$EXISTING_GROUP" ]; then
            usermod -aG "$EXISTING_GROUP" "$DEVELOPER_USER"
        else
            groupadd -g "$DOCKER_GID" docker-host
            usermod -aG docker-host "$DEVELOPER_USER"
        fi
    else
        # Socket is owned by root GID 0
        usermod -aG root "$DEVELOPER_USER"
    fi
fi

# 2. Fix ownership on mounted volumes
mkdir -p "$GEMINI_DIR" "$ANTIGRAVITY_DIR" "$WORKSPACE_DIR"
chown -R ${DEVELOPER_USER}:${DEVELOPER_USER} "$GEMINI_DIR" "$ANTIGRAVITY_DIR"
if [ "$(stat -c '%u' "$WORKSPACE_DIR" 2>/dev/null)" = "0" ]; then
    chown ${DEVELOPER_USER}:${DEVELOPER_USER} "$WORKSPACE_DIR" || true
fi

# 3. Export environment for developer
export HOME="/home/${DEVELOPER_USER}"
export PATH="/home/${DEVELOPER_USER}/.local/bin:/home/${DEVELOPER_USER}/.cargo/bin:/home/${DEVELOPER_USER}/.local/share/pnpm:${PATH}"

# Configure git safe directory for mounted workspaces
gosu "$DEVELOPER_USER" git config --global --add safe.directory '*' 2>/dev/null || true

# Instance name and target port
INSTANCE_NAME="${RC_NAME:-headless-server}"
TARGET_PORT="${AGY_PORT:-4400}"

# Optional Web Terminal (ttyd) launcher
start_web_terminal() {
    local auth_args=()
    if [ -n "$WEB_TERMINAL_USER" ] && [ -n "$WEB_TERMINAL_PASS" ]; then
        auth_args=("-c" "${WEB_TERMINAL_USER}:${WEB_TERMINAL_PASS}")
    fi
    local port="${WEB_TERMINAL_PORT:-7681}"
    echo "🌐 Starting Web Terminal on port ${port}..."
    gosu "$DEVELOPER_USER" ttyd -p "$port" -W "${auth_args[@]}" bash &
}

# 4. Mode dispatch
case "$1" in
    setup)
        echo "==================================================================="
        echo " 🚀 Antigravity CLI First-Time Authentication Setup"
        echo "==================================================================="
        echo "Follow the prompt below to sign in to your Google Account."
        echo "Once authenticated, your token will be saved to persistent storage."
        echo "==================================================================="
        exec gosu "$DEVELOPER_USER" agy --remote-control --remote-control-name "$INSTANCE_NAME"
        ;;

    web-terminal)
        echo "Starting standalone Web Terminal on port ${WEB_TERMINAL_PORT:-7681}..."
        local auth_args=()
        if [ -n "$WEB_TERMINAL_USER" ] && [ -n "$WEB_TERMINAL_PASS" ]; then
            auth_args=("-c" "${WEB_TERMINAL_USER}:${WEB_TERMINAL_PASS}")
        fi
        exec gosu "$DEVELOPER_USER" ttyd -p "${WEB_TERMINAL_PORT:-7681}" -W "${auth_args[@]}" bash
        ;;

    daemon)
        if [ "${ENABLE_WEB_TERMINAL:-false}" = "true" ]; then
            start_web_terminal
        fi

        if [ ! -s "$TOKEN_FILE" ]; then
            echo "==================================================================="
            echo " ⚠️  NOTICE: Antigravity OAuth Token not found!"
            echo "-------------------------------------------------------------------"
            echo " The container is starting in Remote Control mode."
            echo " If this is your first run, check the logs or run the setup command:"
            echo "   docker compose run --rm antigravity-agent setup"
            echo " Or open the sign-in URL shown below in your browser."
            echo "==================================================================="
        else
            echo "==================================================================="
            echo " 🟢 Starting Antigravity Remote Control Daemon: '$INSTANCE_NAME'"
            echo " Exposing on Port: ${TARGET_PORT}"
            echo " Connect anytime from: https://antigravity.google"
            echo " Or access directly via reverse proxy on port ${TARGET_PORT}"
            echo "==================================================================="
        fi

        # Background watchdog: detects agy dynamic port & launches internal reverse proxy with Host header rewriting
        (
            proxy_started=false
            while [ "$proxy_started" = "false" ]; do
                sleep 0.5

                # Detect listening TCP ports on 127.0.0.1 or 0.0.0.0 excluding TARGET_PORT and 7681
                dyn_port=$(ss -tlnH 2>/dev/null | awk '{print $4}' | sed -E 's/.*:([0-9]+)/\1/' | grep -v -E "^(${TARGET_PORT}|7681|0)$" | head -n 1)

                if [ -z "$dyn_port" ]; then
                    dyn_port=$(netstat -tln 2>/dev/null | awk '{print $4}' | sed -E 's/.*:([0-9]+)/\1/' | grep -v -E "^(${TARGET_PORT}|7681|0)$" | head -n 1)
                fi

                if [ -n "$dyn_port" ] && [ "$dyn_port" != "$TARGET_PORT" ]; then
                    echo "==================================================================="
                    echo " 🔗 Reverse Proxy Bridge Active: Exposing dynamic port $dyn_port on port $TARGET_PORT"
                    echo " ➜ Rewriting Host header to 'localhost' to authorize external access"
                    echo " ➜ Reverse proxy & direct URL: http://<your-server-ip>:${TARGET_PORT}"
                    echo "==================================================================="

                    if command -v nginx >/dev/null 2>&1; then
                        # Stop any previous nginx instance
                        nginx -s stop 2>/dev/null || pkill nginx 2>/dev/null || true

                        # Create dedicated Nginx config that rewrites Host & Origin headers to localhost
                        cat <<EOF > /tmp/antigravity_proxy.conf
pid /tmp/nginx.pid;
events {
    worker_connections 1024;
}
http {
    access_log /tmp/nginx_access.log;
    error_log /tmp/nginx_error.log;

    map \$http_upgrade \$connection_upgrade {
        default upgrade;
        ''      close;
    }

    server {
        listen ${TARGET_PORT};
        server_name _;

        location / {
            proxy_pass http://127.0.0.1:${dyn_port};
            proxy_http_version 1.1;

            # Rewrite Host & Origin to satisfy Antigravity localhost security check
            proxy_set_header Host localhost;
            proxy_set_header Origin "http://localhost";

            # WebSocket & SSE Streaming Support
            proxy_set_header Upgrade \$http_upgrade;
            proxy_set_header Connection \$connection_upgrade;

            proxy_set_header X-Real-IP \$remote_addr;
            proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto \$scheme;

            proxy_read_timeout 86400s;
            proxy_send_timeout 86400s;
            proxy_buffering off;
        }
    }
}
EOF
                        nginx -c /tmp/antigravity_proxy.conf
                        proxy_started=true
                        break
                    elif command -v socat >/dev/null 2>&1; then
                        pkill -f "socat TCP-LISTEN:${TARGET_PORT}" 2>/dev/null || true
                        socat TCP-LISTEN:"${TARGET_PORT}",fork,reuseaddr TCP:127.0.0.1:"${dyn_port}" &
                        proxy_started=true
                        break
                    fi
                fi
            done
        ) &

        cd "$WORKSPACE_DIR"
        exec gosu "$DEVELOPER_USER" agy --remote-control --remote-control-name "$INSTANCE_NAME"
        ;;

    *)
        # If user passed custom command (e.g. bash, npm, python, docker)
        if [ "$1" = "bash" ] || [ "$1" = "zsh" ] || [ "$1" = "sh" ]; then
            exec gosu "$DEVELOPER_USER" "$@"
        else
            exec gosu "$DEVELOPER_USER" "$@"
        fi
        ;;
esac

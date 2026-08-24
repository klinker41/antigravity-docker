#!/usr/bin/env bash
set -e

DEVELOPER_USER="developer"
GEMINI_DIR="/home/${DEVELOPER_USER}/.gemini"
ANTIGRAVITY_DIR="/home/${DEVELOPER_USER}/.antigravity"
TOKEN_FILE="${GEMINI_DIR}/jetski-standalone-oauth-token"
WORKSPACE_DIR="/workspace"

# Instance name and target port
INSTANCE_NAME="${RC_NAME:-headless-server}"
TARGET_PORT="${AGY_PORT:-4400}"

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

# 2. Fix ownership & initialize default configs on mounted volumes
mkdir -p "$GEMINI_DIR/config" "$GEMINI_DIR/antigravity" "$ANTIGRAVITY_DIR" "$WORKSPACE_DIR"

# Initialize config.json if not present
if [ ! -f "$GEMINI_DIR/config/config.json" ]; then
    cat <<EOF > "$GEMINI_DIR/config/config.json"
{
  "userSettings": {
    "artifactReviewMode": "ARTIFACT_REVIEW_MODE_ALWAYS",
    "autoExecutionPolicy": "CASCADE_COMMANDS_AUTO_EXECUTION_EAGER",
    "enableTerminalSandbox": false,
    "nonWorkspaceFileAccessPolicy": "AGENT_SETTING_POLICY_ALLOW",
    "queuedMessageDeliveryStrategy": "MESSAGE_DELIVERY_STRATEGY_NEXT_INVOCATION",
    "remoteControlEnabled": true,
    "cliRemoteControlHostname": "${INSTANCE_NAME}",
    "remoteControlHostname": "${INSTANCE_NAME}",
    "themeMode": "THEME_MODE_DARK",
    "useAiCredits": true
  }
}
EOF
fi

# Scan /workspace and register all subfolders as individual projects in projects.json
node -e '
const fs = require("fs");
const path = require("path");

const projectsFile = process.argv[1];
const workspaceDir = process.argv[2];

let projectsData = { projects: {} };
if (fs.existsSync(projectsFile)) {
    try {
        projectsData = JSON.parse(fs.readFileSync(projectsFile, "utf8")) || { projects: {} };
        if (!projectsData.projects) projectsData.projects = {};
    } catch (e) {
        projectsData = { projects: {} };
    }
}

if (fs.existsSync(workspaceDir)) {
    const entries = fs.readdirSync(workspaceDir, { withFileTypes: true });
    let subdirsFound = false;
    for (const entry of entries) {
        if (entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules" && entry.name !== "dist" && entry.name !== "build") {
            const fullPath = path.join(workspaceDir, entry.name);
            projectsData.projects[fullPath] = entry.name;
            subdirsFound = true;
        }
    }
    // If no subdirectories exist yet, register /workspace itself
    if (!subdirsFound && Object.keys(projectsData.projects).length === 0) {
        projectsData.projects[workspaceDir] = "workspace";
    }
}

fs.writeFileSync(projectsFile, JSON.stringify(projectsData, null, 2), "utf8");
' "$GEMINI_DIR/projects.json" "$WORKSPACE_DIR"

# Always ensure agent_onboarding_completed is set in antigravity_state.pbtxt to bypass onboarding flow
STATE_CONTENT='post_onboarding: {
  completed_steps: POST_ONBOARDING_STEP_TYPE_MANAGER_WELCOME
  completed_steps: POST_ONBOARDING_STEP_TYPE_USAGE_MODE
  completed_steps: POST_ONBOARDING_STEP_TYPE_AGENT_CONFIGURATION
  completed_steps: POST_ONBOARDING_STEP_TYPE_ADD_WORKSPACE
}
seen_nuxs: {
  uids: 31
  uids: 29
  uids: 24
  uids: 23
  uids: 38
}
agent_onboarding_completed: AGENT_ONBOARDING_STATE_COMPLETED
migrate_convos_into_projects: MIGRATION_STATUS_COMPLETED
migrate_retroactive_projects: RETROACTIVE_MIGRATION_STATUS_COMPLETED_UNNECESSARY'

echo "$STATE_CONTENT" > "$ANTIGRAVITY_DIR/antigravity_state.pbtxt"
echo "$STATE_CONTENT" > "$GEMINI_DIR/antigravity/antigravity_state.pbtxt"

chown -R ${DEVELOPER_USER}:${DEVELOPER_USER} "$GEMINI_DIR" "$ANTIGRAVITY_DIR"
if [ "$(stat -c '%u' "$WORKSPACE_DIR" 2>/dev/null)" = "0" ]; then
    chown ${DEVELOPER_USER}:${DEVELOPER_USER} "$WORKSPACE_DIR" || true
fi

# 3. Export environment for developer
export HOME="/home/${DEVELOPER_USER}"
export PATH="/home/${DEVELOPER_USER}/.local/bin:/home/${DEVELOPER_USER}/.cargo/bin:/home/${DEVELOPER_USER}/.local/share/pnpm:${PATH}"

# Configure git safe directory for mounted workspaces
gosu "$DEVELOPER_USER" git config --global --add safe.directory '*' 2>/dev/null || true

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

        rm -f /tmp/antigravity_port

        # Start Node.js Authentication & Reverse Proxy Gateway
        export AGY_PORT="${TARGET_PORT}"
        export AUTH_PASSWORD="${AUTH_PASSWORD:-}"
        node /usr/local/bin/auth-proxy.js &

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
            echo " Password Protection: $([ -n "$AUTH_PASSWORD" ] && echo 'ENABLED 🔒' || echo 'DISABLED (Set AUTH_PASSWORD in .env to enable)')"
            echo "==================================================================="
        fi

        cd "$WORKSPACE_DIR"

        # Launch agy, printing output while capturing the exact web server port
        gosu "$DEVELOPER_USER" agy --remote-control --remote-control-name "$INSTANCE_NAME" 2>&1 | while IFS= read -r line; do
            echo "$line"
            if [[ "$line" =~ (http://localhost:|http://127\.0\.0\.1:)([0-9]+) ]]; then
                detected_port="${BASH_REMATCH[2]}"
                if [ -n "$detected_port" ]; then
                    echo "$detected_port" > /tmp/antigravity_port
                fi
            fi
        done
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

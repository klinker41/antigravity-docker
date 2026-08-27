#!/usr/bin/env bash
set -e

DEVELOPER_USER="developer"
GEMINI_DIR="/home/${DEVELOPER_USER}/.gemini"
TOKEN_FILE="${GEMINI_DIR}/jetski-standalone-oauth-token"
WORKSPACE_DIR="/workspace"

# Instance name and target port
INSTANCE_NAME="${RC_NAME:-server-agent}"
TARGET_PORT="${AGY_PORT:-4400}"

# 1. Dynamically configure user/group UID and GID (PUID/PGID)
PUID="${PUID:-1000}"
PGID="${PGID:-1000}"

CURRENT_GID=$(id -g "$DEVELOPER_USER" 2>/dev/null || echo "1000")
if [ "$PGID" != "$CURRENT_GID" ]; then
    EXISTING_GROUP=$(getent group "$PGID" | cut -d: -f1 || true)
    if [ -n "$EXISTING_GROUP" ]; then
        usermod -g "$PGID" "$DEVELOPER_USER"
    else
        groupmod -g "$PGID" "$DEVELOPER_USER" 2>/dev/null || (groupadd -g "$PGID" developer-group && usermod -g "$PGID" "$DEVELOPER_USER")
    fi
fi

CURRENT_UID=$(id -u "$DEVELOPER_USER" 2>/dev/null || echo "1000")
if [ "$PUID" != "$CURRENT_UID" ]; then
    usermod -u "$PUID" "$DEVELOPER_USER"
fi

# 2. Initialize persistent directories and default configs on mounted volumes
mkdir -p "$GEMINI_DIR/config/projects" \
         "$GEMINI_DIR/config/sidecars" \
         "$GEMINI_DIR/antigravity/sidecar_data" \
         "$GEMINI_DIR/antigravity-cli/conversations" \
         "$GEMINI_DIR/antigravity-cli/brain" \
         "$GEMINI_DIR/antigravity-cli/annotations" \
         "$GEMINI_DIR/antigravity-cli/log" \
         "$GEMINI_DIR/antigravity-cli/crashes" \
         "$GEMINI_DIR/antigravity-cli/knowledge" \
         "$WORKSPACE_DIR"

# Ensure default outside-of-project and root .json configs exist
if [ ! -f "$GEMINI_DIR/config/projects/outside-of-project.json" ]; then
    cat <<EOF > "$GEMINI_DIR/config/projects/outside-of-project.json"
{
  "id": "outside-of-project",
  "name": "Outside of Project",
  "projectResources": {
    "resources": []
  },
  "settings": {},
  "updatedAt": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
  "isWorkspaceOnly": false
}
EOF
fi

if [ ! -f "$GEMINI_DIR/config/projects/.json" ]; then
    cp "$GEMINI_DIR/config/projects/outside-of-project.json" "$GEMINI_DIR/config/projects/.json" 2>/dev/null || true
fi

# Initialize config.json if not present
if [ ! -f "$GEMINI_DIR/config/config.json" ]; then
    cat <<EOF > "$GEMINI_DIR/config/config.json"
{
  "userSettings": {
    "artifactReviewMode": "ARTIFACT_REVIEW_MODE_ALWAYS",
    "autoExecutionPolicy": "CASCADE_COMMANDS_AUTO_EXECUTION_PROCEED_IN_SANDBOX",
    "cliRemoteControlHostname": "${INSTANCE_NAME}",
    "enableTerminalSandbox": true,
    "nonWorkspaceFileAccessPolicy": "AGENT_SETTING_POLICY_DENY",
    "queuedMessageDeliveryStrategy": "MESSAGE_DELIVERY_STRATEGY_NEXT_INVOCATION",
    "remoteControlEnabled": true,
    "remoteControlHostname": "${INSTANCE_NAME}",
    "themeMode": "THEME_MODE_DARK",
    "useAiCredits": true
  }
}
EOF
fi

# Scan /workspace and register each folder as a separate project in ~/.gemini/config/projects/<UUID>.json
# only if the projects folder is empty
if [ -z "$(ls -A "$GEMINI_DIR/config/projects" 2>/dev/null)" ]; then
    node -e '
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const projectsDir = process.argv[1];
const workspaceDir = process.argv[2];

fs.mkdirSync(projectsDir, { recursive: true });

// Check if projects directory is already populated
const existingFiles = fs.readdirSync(projectsDir).filter(f => f.endsWith(".json") && f !== ".json");
if (existingFiles.length > 0) {
    process.exit(0);
}

function registerProject(folderPath, folderName) {
    const uri = `file://${folderPath}`;
    const id = crypto.randomUUID();
    const projectData = {
        id: id,
        name: folderName,
        projectResources: {
            resources: [
                {
                    gitFolder: {
                        folderUri: uri,
                        defaultBranch: "main"
                    }
                }
            ]
        },
        settings: {},
        updatedAt: new Date().toISOString(),
        isWorkspaceOnly: false
    };

    fs.writeFileSync(path.join(projectsDir, `${id}.json`), JSON.stringify(projectData, null, 2), "utf8");
    console.log(`[Project Registry] Registered project: "${folderName}" (${id})`);
}

// Create outside-of-project.json default configuration
const outsideOfProject = {
    id: "outside-of-project",
    name: "Outside of Project",
    projectResources: { resources: [] },
    settings: {},
    updatedAt: new Date().toISOString(),
    isWorkspaceOnly: false
};
fs.writeFileSync(path.join(projectsDir, "outside-of-project.json"), JSON.stringify(outsideOfProject, null, 2), "utf8");

if (fs.existsSync(workspaceDir)) {
    const entries = fs.readdirSync(workspaceDir, { withFileTypes: true });
    let subdirsFound = false;
    for (const entry of entries) {
        if (entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules" && entry.name !== "dist" && entry.name !== "build") {
            const fullPath = path.join(workspaceDir, entry.name);
            registerProject(fullPath, entry.name);
            subdirsFound = true;
        }
    }
    if (!subdirsFound) {
        registerProject(workspaceDir, "workspace");
    }
}
' "$GEMINI_DIR/config/projects" "$WORKSPACE_DIR"
fi


# Initialize antigravity_state.pbtxt only if not already present
STATE_FILE="$GEMINI_DIR/antigravity-cli/antigravity_state.pbtxt"
if [ ! -f "$STATE_FILE" ]; then
    cat <<EOF > "$STATE_FILE"
post_onboarding: {
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
migrate_retroactive_projects: RETROACTIVE_MIGRATION_STATUS_COMPLETED_UNNECESSARY
EOF
else
    # Ensure onboarding completion flag is present without wiping installation_uuid or migrations
    if ! grep -q "agent_onboarding_completed" "$STATE_FILE"; then
        echo "agent_onboarding_completed: AGENT_ONBOARDING_STATE_COMPLETED" >> "$STATE_FILE"
    fi
fi

# Fix ownership and ensure read/write permissions on mounted volume
chown -R ${DEVELOPER_USER}:${DEVELOPER_USER} "$GEMINI_DIR" "/home/${DEVELOPER_USER}"
chmod -R u+rwX,g+rwX "$GEMINI_DIR" || true

if [ "$(stat -c '%u' "$WORKSPACE_DIR" 2>/dev/null)" = "0" ]; then
    chown ${DEVELOPER_USER}:${DEVELOPER_USER} "$WORKSPACE_DIR" || true
fi

# Configure SSH directory, permissions, and client defaults
SSH_DIR="/home/${DEVELOPER_USER}/.ssh"
mkdir -p "$SSH_DIR"
chown -R ${DEVELOPER_USER}:${DEVELOPER_USER} "$SSH_DIR"
chmod 700 "$SSH_DIR"

# Enforce strict permissions for SSH keys, configs, and known_hosts
if [ -d "$SSH_DIR" ]; then
    chmod 600 "$SSH_DIR"/id_* "$SSH_DIR"/*.pem "$SSH_DIR"/*.key 2>/dev/null || true
    chmod 644 "$SSH_DIR"/*.pub "$SSH_DIR"/known_hosts "$SSH_DIR"/config 2>/dev/null || true
fi

# Ensure default SSH client config exists with accept-new host key policy
if [ ! -f "$SSH_DIR/config" ]; then
    cat <<EOF > "$SSH_DIR/config"
Host *
    StrictHostKeyChecking accept-new
EOF
    chown ${DEVELOPER_USER}:${DEVELOPER_USER} "$SSH_DIR/config"
    chmod 644 "$SSH_DIR/config"
fi

# Seed common Git host keys into known_hosts if missing
if [ ! -f "$SSH_DIR/known_hosts" ] || ! grep -q "github.com" "$SSH_DIR/known_hosts" 2>/dev/null; then
    ssh-keyscan -t ed25519,rsa github.com >> "$SSH_DIR/known_hosts" 2>/dev/null || true
    ssh-keyscan -t ed25519,rsa gitlab.com >> "$SSH_DIR/known_hosts" 2>/dev/null || true
    chown ${DEVELOPER_USER}:${DEVELOPER_USER} "$SSH_DIR/known_hosts" 2>/dev/null || true
    chmod 644 "$SSH_DIR/known_hosts" 2>/dev/null || true
fi

# Ensure developer ownership for .gitconfig if present
GITCONFIG_FILE="/home/${DEVELOPER_USER}/.gitconfig"
if [ -e "$GITCONFIG_FILE" ]; then
    chown ${DEVELOPER_USER}:${DEVELOPER_USER} "$GITCONFIG_FILE" 2>/dev/null || true
fi

# Set umask to enforce secure default file creation permissions
umask 0022

# 3. Configure Telemetry Blocking (DNS Sinkhole and OpenTelemetry opt-outs)
BLOCK_TELEMETRY="${BLOCK_TELEMETRY:-true}"

if [ "$BLOCK_TELEMETRY" = "true" ] || [ "$BLOCK_TELEMETRY" = "1" ] || [ "$BLOCK_TELEMETRY" = "yes" ] || [ "$BLOCK_TELEMETRY" = "on" ]; then
    echo " 🛡️  Telemetry Blocking is ENABLED (Sinkholing telemetry endpoints to 0.0.0.0)"
    
    # Configure OpenTelemetry & telemetry opt-out environment variables
    export DO_NOT_TRACK="1"
    export OTEL_SDK_DISABLED="true"
    export OTEL_TRACES_EXPORTER="none"
    export OTEL_METRICS_EXPORTER="none"
    export OTEL_LOGS_EXPORTER="none"

    # Append telemetry domains to /etc/hosts if not already present
    if ! grep -q "antigravity-telemetry-sinkhole" /etc/hosts 2>/dev/null; then
        cat << 'EOF' >> /etc/hosts

# >>> antigravity-telemetry-sinkhole >>>
0.0.0.0 firebaselogging-pa.googleapis.com
0.0.0.0 feedback-pa.googleapis.com
0.0.0.0 cloudtrace.googleapis.com
0.0.0.0 clouderrorreporting.googleapis.com
0.0.0.0 logging.googleapis.com
0.0.0.0 monitoring.googleapis.com
0.0.0.0 telemetry.google.com
0.0.0.0 client-telemetry.google.com
0.0.0.0 www.google-analytics.com
0.0.0.0 google-analytics.com
0.0.0.0 stats.g.doubleclick.net
0.0.0.0 v1.telemetry.coder.com
0.0.0.0 telemetry.code-server.com
# <<< antigravity-telemetry-sinkhole <<<
EOF
    fi
else
    echo " ⚠️  Telemetry Blocking is DISABLED (BLOCK_TELEMETRY=false)"
fi

# 4. Export environment for developer
export HOME="/home/${DEVELOPER_USER}"
export PATH="/home/${DEVELOPER_USER}/.gemini/antigravity-cli/bin:/home/${DEVELOPER_USER}/.local/bin:/home/${DEVELOPER_USER}/.cargo/bin:/home/${DEVELOPER_USER}/.local/share/pnpm:${PATH}"

# Configure git safe directory for mounted workspaces and persistent config
gosu "$DEVELOPER_USER" git config --global --add safe.directory "$WORKSPACE_DIR" 2>/dev/null || true
gosu "$DEVELOPER_USER" git config --global --add safe.directory "${WORKSPACE_DIR}/*" 2>/dev/null || true
gosu "$DEVELOPER_USER" git config --global --add safe.directory "$GEMINI_DIR" 2>/dev/null || true
gosu "$DEVELOPER_USER" git config --global --add safe.directory "$ANTIGRAVITY_DIR" 2>/dev/null || true

# 5. Mode dispatch
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

    daemon)
        rm -f /tmp/antigravity_port

        ENABLE_IDE="${ENABLE_IDE:-true}"
        ENABLE_TERMINAL="${ENABLE_TERMINAL:-true}"

        # 1. Start code-server (VS Code Web IDE) on 127.0.0.1:8080 if enabled
        if [ "$ENABLE_IDE" = "true" ] || [ "$ENABLE_IDE" = "1" ] || [ "$ENABLE_IDE" = "yes" ] || [ "$ENABLE_IDE" = "on" ]; then
            ASSETS_DIR="/usr/local/share/antigravity/assets"
            [ ! -d "$ASSETS_DIR" ] && ASSETS_DIR="/workspace/assets"
            [ ! -d "$ASSETS_DIR" ] && ASSETS_DIR="/workspace/antigravity-docker/assets"
            if [ -d "$ASSETS_DIR" ]; then
                if [ -d /usr/lib/code-server/src/browser/media ]; then
                    cp "$ASSETS_DIR"/favicon.svg /usr/lib/code-server/src/browser/media/favicon.svg 2>/dev/null || true
                    cp "$ASSETS_DIR"/favicon.svg /usr/lib/code-server/src/browser/media/favicon-dark-support.svg 2>/dev/null || true
                    cp "$ASSETS_DIR"/favicon.ico /usr/lib/code-server/src/browser/media/favicon.ico 2>/dev/null || true
                    cp "$ASSETS_DIR"/pwa-icon-192.png /usr/lib/code-server/src/browser/media/pwa-icon-192.png 2>/dev/null || true
                    cp "$ASSETS_DIR"/pwa-icon-512.png /usr/lib/code-server/src/browser/media/pwa-icon-512.png 2>/dev/null || true
                fi
                if [ -d /usr/lib/code-server/lib/vscode/resources/server ]; then
                    cp "$ASSETS_DIR"/favicon.ico /usr/lib/code-server/lib/vscode/resources/server/favicon.ico 2>/dev/null || true
                fi
            fi

            echo " 🟢 Starting code-server Web IDE on internal port 8080"
            gosu "$DEVELOPER_USER" code-server \
                --bind-addr 127.0.0.1:8080 \
                --auth none \
                --disable-telemetry \
                --disable-update-check \
                "$WORKSPACE_DIR" > /tmp/code-server.log 2>&1 &
        else
            echo " ⚪ Web IDE is DISABLED (ENABLE_IDE=false)"
        fi

        # 2. Start ttyd (Web Terminal) on 127.0.0.1:7681 if enabled
        if [ "$ENABLE_TERMINAL" = "true" ] || [ "$ENABLE_TERMINAL" = "1" ] || [ "$ENABLE_TERMINAL" = "yes" ] || [ "$ENABLE_TERMINAL" = "on" ]; then
            echo " 🟢 Starting ttyd Web Terminal on internal port 7681"
            gosu "$DEVELOPER_USER" ttyd \
                -W \
                -p 7681 \
                -i 127.0.0.1 \
                -b /terminal \
                -t fontSize=14 \
                -t fontFamily="Google Sans Code, monospace" \
                -t theme='{"background": "#08090d", "foreground": "#f0f4fc", "cursor": "#38bdf8"}' \
                /usr/local/bin/host-terminal.sh > /tmp/ttyd.log 2>&1 &
        else
            echo " ⚪ Host Web Terminal is DISABLED (ENABLE_TERMINAL=false)"
        fi

        export AGY_PORT="${TARGET_PORT}"
        export AUTH_PASSWORD="${AUTH_PASSWORD:-}"
        export BLOCK_TELEMETRY="${BLOCK_TELEMETRY}"
        export ENABLE_IDE="${ENABLE_IDE}"
        export ENABLE_TERMINAL="${ENABLE_TERMINAL}"
        export HOST_SSH_USER="${HOST_SSH_USER:-}"
        export HOST_SSH_HOST="${HOST_SSH_HOST:-host.docker.internal}"
        export HOST_SSH_PORT="${HOST_SSH_PORT:-22}"
        export HOST_SSH_DIR="${HOST_SSH_DIR:-}"
        gosu "$DEVELOPER_USER" node /usr/local/bin/auth-proxy.js &

        if [ ! -s "$TOKEN_FILE" ]; then
            echo "==================================================================="
            echo " ⚠️  NOTICE: Antigravity OAuth Token not found!"
            echo "-------------------------------------------------------------------"
            echo " The container is starting in Remote Control mode."
            echo " If this is your first run, check the logs or run the setup command:"
            echo "   docker compose run --rm antigravity setup"
            echo " Or via standalone docker run:"
            echo "   docker run -it --rm -v /path/to/data:/home/developer/.gemini jklinker/antigravity-docker:latest setup"
            echo " Or open the sign-in URL shown below in your browser."
            echo "==================================================================="
        else
            echo "==================================================================="
            echo " 🟢 Starting Antigravity Remote Control Daemon: '$INSTANCE_NAME'"
            echo " Exposing on Port: ${TARGET_PORT}"
            echo " Password Protection: $([ -n "$AUTH_PASSWORD" ] && echo 'ENABLED 🔒' || echo 'DISABLED (Set AUTH_PASSWORD to enable)')"
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
                    echo "127.0.0.1:$detected_port" > /tmp/antigravity_ls_address
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

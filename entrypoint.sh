#!/usr/bin/env bash
set -e

DEVELOPER_USER="developer"
GEMINI_DIR="/home/${DEVELOPER_USER}/.gemini"
ANTIGRAVITY_DIR="/home/${DEVELOPER_USER}/.antigravity"
TOKEN_FILE="${GEMINI_DIR}/jetski-standalone-oauth-token"
WORKSPACE_DIR="/workspace"

# Instance name and target port
INSTANCE_NAME="${RC_NAME:-server-agent}"
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
mkdir -p "$GEMINI_DIR/config/projects" \
         "$GEMINI_DIR/antigravity-cli" \
         "$GEMINI_DIR/antigravity" \
         "$ANTIGRAVITY_DIR" \
         "$WORKSPACE_DIR"

# Initialize config.json if not present
if [ ! -f "$GEMINI_DIR/config/config.json" ]; then
    cat <<EOF > "$GEMINI_DIR/config/config.json"
{
  "userSettings": {
    "artifactReviewMode": "ARTIFACT_REVIEW_MODE_TURBO",
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
const existingFiles = fs.readdirSync(projectsDir);
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


# Always ensure agent_onboarding_completed is set in antigravity-cli state file to bypass onboarding flow
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

echo "$STATE_CONTENT" > "$GEMINI_DIR/antigravity-cli/antigravity_state.pbtxt"
echo "$STATE_CONTENT" > "$GEMINI_DIR/antigravity/antigravity_state.pbtxt"
echo "$STATE_CONTENT" > "$ANTIGRAVITY_DIR/antigravity_state.pbtxt"

chown -R ${DEVELOPER_USER}:${DEVELOPER_USER} "$GEMINI_DIR" "$ANTIGRAVITY_DIR"
if [ "$(stat -c '%u' "$WORKSPACE_DIR" 2>/dev/null)" = "0" ]; then
    chown ${DEVELOPER_USER}:${DEVELOPER_USER} "$WORKSPACE_DIR" || true
fi

# 3. Export environment for developer
export HOME="/home/${DEVELOPER_USER}"
export PATH="/home/${DEVELOPER_USER}/.local/bin:/home/${DEVELOPER_USER}/.cargo/bin:/home/${DEVELOPER_USER}/.local/share/pnpm:${PATH}"

# Configure git safe directory for mounted workspaces
gosu "$DEVELOPER_USER" git config --global --add safe.directory '*' 2>/dev/null || true

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

    daemon)
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

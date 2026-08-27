# Headless Antigravity Docker Agent with Remote Control, Sidecars & IDE

Run Google Antigravity in **headless Remote Control mode** on your server.
Connect to your agent from any browser via your reverse proxy or local network
with built-in password protection, an integrated **Sidecar Manager** for
scheduled agent prompts and autonomous workers, a **VS Code Web IDE** for
inspecting project files, and a **Host Web Terminal** for running commands on
the host machine.

---

## 🚀 Docker Compose

Add this service to your `docker-compose.yml`:

```yaml
version: '3.8'

services:
  antigravity:
    image: jklinker/antigravity-docker:latest
    container_name: antigravity
    restart: unless-stopped
    ports:
      - "4400:4400"
    environment:
      - PUID=1000
      - PGID=1000
      - RC_NAME=<remote-control-name>
      - AGY_PORT=4400
      - AUTH_PASSWORD=<password-for-login>
      - ENABLE_IDE=true
      - ENABLE_TERMINAL=true
      - HOST_SSH_USER=<host-username>
      - HOST_SSH_HOST=host.docker.internal
      - HOST_SSH_PORT=22
      - HOST_SSH_DIR=<host-directory-path>
    extra_hosts:
      - "host.docker.internal:host-gateway"
    volumes:
      - <location-of-projects>:/workspace
      - <location-of-config>:/home/developer/.gemini
      - <location-of-ssh>:/home/developer/.ssh
      - <location-of-gitconfig>:/home/developer/.gitconfig
```

---

## ⚙️ Configuration

### Environment Variables

| Variable | Default | Description |
| :--- | :--- | :--- |
| `PUID` | `1000` | User ID for the internal developer user. Set to your host user's UID to prevent file permission mismatches. |
| `PGID` | `1000` | Group ID for the internal developer user. Set to your host group's GID to prevent file permission mismatches. |
| `RC_NAME` | `server-agent` | Identifier name for this server instance. |
| `AGY_PORT` | `4400` | Port exposed by the built-in web gateway. |
| `AUTH_PASSWORD` | *(empty)* | Optional password to protect web access. When set, prompts for login and remembers session for 30 days. |
| `BLOCK_TELEMETRY` | `true` | When `true` (default), blocks Google usage telemetry, analytics, crash reporting, and diagnostic tracking domains via in-container DNS sinkholing (`0.0.0.0`) and disables OpenTelemetry exporters, while keeping Gemini model APIs and authentication working seamlessly. |
| `ENABLE_IDE` | `true` | Set to `false` to disable the VS Code Web IDE service and hide its UI button. |
| `ENABLE_TERMINAL` | `true` | Set to `false` to disable the Host Web Terminal service and hide its UI button. |
| `HOST_SSH_USER` | *(workspace owner)* | Host username used by the Web Terminal to connect to the host machine via SSH. |
| `HOST_SSH_HOST` | `host.docker.internal` | Hostname/IP used by Web Terminal to reach the host machine. |
| `HOST_SSH_PORT` | `22` | SSH port on the host machine. |
| `HOST_SSH_DIR` | *(host user home)* | *(Optional)* Absolute directory on the host machine to automatically `cd` into when opening the Web Terminal. |
| `TRUST_PROXY` | `false` | When `true`, trusts `X-Forwarded-For` from reverse proxies for rate limiting. |
| `ALLOWED_ORIGINS` | *(empty)* | Optional comma-separated list of allowed CORS origins. |

### Volumes

| Volume | Container Path | Description |
| :--- | :--- | :--- |
| `<location-of-projects>` | `/workspace` | Host directory where your Git repositories and codebases live. |
| `<location-of-config>` | `/home/developer/.gemini` | Host directory where Antigravity OAuth tokens, project configs, and sidecar definitions persist. |
| `<location-of-ssh>` | `/home/developer/.ssh` | *(Recommended)* Host directory persisting container-dedicated SSH keys and configs. |
| `<location-of-gitconfig>` | `/home/developer/.gitconfig` | *(Optional)* Host file persisting container Git configuration. |

---

## 🔑 Setup & Authentication

### Step 1: One-Time Google Authentication
Run the interactive setup inside the container:

**Via Docker Compose:**
```bash
docker compose run --rm antigravity setup
```

**Via Standalone Docker:**
```bash
docker run -it --rm \
  -v "<location-of-config>:/home/developer/.gemini" \
  jklinker/antigravity-docker:latest setup
```

1. Open the Google sign-in URL shown in the terminal.
2. Sign in to your Google Account to authorize Antigravity.
3. Your OAuth token is automatically saved into your persistent config
   directory on the host.

### Step 2: Start the Agent
```bash
docker compose up -d
```

### Step 3: Configure Dedicated SSH Keys & Git Identity (Recommended)
To keep your container isolated from host credentials, generate dedicated SSH
keys and Git identity inside the container:

**1. Generate dedicated SSH keypair:**
```bash
docker compose exec antigravity ssh-keygen -t ed25519 -C "antigravity-container" -f /home/developer/.ssh/id_ed25519 -N ""
```

**2. Configure Git identity:**
```bash
docker compose exec antigravity git config --global user.name "Your Name"
docker compose exec antigravity git config --global user.email "your.email@example.com"
```

**3. Authorize public key:**
Display the generated public key:
```bash
docker compose exec antigravity cat /home/developer/.ssh/id_ed25519.pub
```
- **For GitHub / GitLab**: Add this public key under **Settings → SSH and GPG
  keys** (or as a repository **Deploy Key** with write access).
- **For Host Web Terminal**: If `ENABLE_TERMINAL=true` is enabled to run
  commands on the host machine, append the public key to your host's
  `~/.ssh/authorized_keys` (on Unraid, save to
  `/boot/config/ssh/root/authorized_keys` to persist across reboots).

---

## 🌐 Accessing the Agent & Workspace Services

Navigate to `http://<your-server-ip>:4400` in your browser (or through your
reverse proxy). If configured, enter your `AUTH_PASSWORD` on the login screen to
unlock your session for 30 days.

Once logged in, all services are accessible:

| Service | Path | Description | Authentication |
| :--- | :--- | :--- | :--- |
| **Google Antigravity UI** | `/` | Main chat and conversation interface. Injected with **Sidecar Manager**, **Web IDE**, and **Host Terminal** buttons in the left navigation sidebar. | Protected 🔒 |
| **Sidecar Manager** | `/sidecars` | Web UI for defining, scheduling, and monitoring background sidecars and recurring agent prompts. | Protected 🔒 |
| **VS Code Web IDE** | `/ide/` | Full-featured VS Code in the browser for viewing and editing raw project files in `/workspace`. | Protected 🔒 |
| **Host Web Terminal** | `/terminal/` | Web terminal running interactive SSH sessions directly on the host machine (manage Docker, run system commands, git, etc.). | Protected 🔒 |
| **Health & Service Status** | `/status` | Real-time health check endpoint for monitoring service uptime. | **Public / Unauthenticated** 🟢 |

---

## 🤖 Sidecar Manager

The built-in **Sidecar Manager** allows you to schedule recurring agent prompts
(e.g., hourly PR triage, daily summaries) and run background workers directly
alongside your Antigravity container.

Access it by clicking **Sidecar Manager** in the left navigation pane of the
Antigravity UI or navigating directly to `/sidecars`.

### Features:
- **Scheduled Agent Prompts**: Define prompts that run automatically on a
  standard 5-field cron schedule (e.g. `0 * * * *`, `0 9 * * 1-5`) using
  `agentapi new-conversation` targeted to specific projects.
- **Continuous Workers**: Run long-running daemons or background scripts with
  automatic process supervision and configurable restart policies (`always`,
  `on-failure`, `never`).
- **Interactive Management**: Toggle sidecars on or off in real-time, trigger
  manual runs immediately with one click, view live stdout/stderr logs, and edit
  configurations.
- **Spec-Compliant Persistence**: Sidecar configurations are saved to
  `~/.gemini/config/sidecars/<id>/sidecar.json` and enabled states are stored in
  `~/.gemini/config/config.json`.
- **Comprehensive Logging**: Sidecar output is written to
  `~/.gemini/antigravity/sidecar_data/<id>/logs/` and runtime events appear
  directly in `docker compose logs` for debugging.

---

## 🛡️ Privacy & Telemetry Management

By default, `BLOCK_TELEMETRY=true` is enabled to prevent usage telemetry,
analytics, and diagnostic tracking from being sent back to Google while
keeping core agent capabilities, Gemini model APIs, and authentication fully
operational.

### How it Works:
- **In-Container DNS Sinkholing**: Telemetry hostnames are sinkholed to
  `0.0.0.0` directly inside the container (`/etc/hosts`), resulting in
  immediate socket rejection (`ECONNREFUSED`) with zero DNS lookup or request
  timeout latency.
- **Environment Opt-Outs**: Automatically exports `DO_NOT_TRACK=1`,
  `OTEL_SDK_DISABLED=true`, `OTEL_TRACES_EXPORTER=none`,
  `OTEL_METRICS_EXPORTER=none`, and `OTEL_LOGS_EXPORTER=none`.
- **Allowed Traffic**: Essential authentication endpoints
  (`accounts.google.com`, `oauth2.googleapis.com`) and Gemini AI inference APIs
  (`cloudaicompanion.googleapis.com`, `cloudcode-pa.googleapis.com`,
  `generativelanguage.googleapis.com`) continue to pass through unobstructed.
- **Blocked Endpoints**: Sinkholes `firebaselogging-pa.googleapis.com`,
  `feedback-pa.googleapis.com`, `cloudtrace.googleapis.com`,
  `clouderrorreporting.googleapis.com`, `logging.googleapis.com`,
  `monitoring.googleapis.com`, `telemetry.google.com`,
  `client-telemetry.google.com`, `google-analytics.com`, and
  `v1.telemetry.coder.com`.

To disable blocking and allow all telemetry, set `BLOCK_TELEMETRY=false` in your
`docker-compose.yml` or container environment.

---

## 🛠️ Building & Pushing to Docker Hub

If you want to build the Docker image from source and push it to Docker Hub:

```bash
docker build -t jklinker/antigravity-docker:latest .
docker push jklinker/antigravity-docker:latest
```

> [!TIP]
> **Multi-Platform Build**: To build and push for multiple architectures (such
> as `linux/amd64` and `linux/arm64` for Apple Silicon or ARM servers) using
> Docker Buildx:
> ```bash
> docker buildx build --platform linux/amd64,linux/arm64 -t jklinker/antigravity-docker:latest --push .
> ```

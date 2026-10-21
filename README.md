# Headless Antigravity Docker Agent with Remote Control, Sidecars & IDE

Run Google Antigravity in **headless Remote Control mode** on your server.
Connect to your agent from any browser via your reverse proxy or local network
with built-in password protection, an integrated **Sidecar Manager** for
scheduled agent prompts and autonomous workers, a **VS Code Web IDE** for
inspecting project files, a **Host Web Terminal** for running commands on
the host machine, and **External Model Providers** for using Anthropic,
OpenAI, or local Ollama directly in Antigravity. The web gateway is
powered by **Bun** and **Hono** for ultra-fast startup and low memory usage.

---

## 🚀 Docker Compose

Add this service to your `docker-compose.yml`:

```yaml
version: '3.8'

services:
  antigravity:
    image: jklinker/antigravity:latest
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
| `AGY_HUB_PORT` | `4402` | Internal upstream port passed to `agy --hub-port`. |
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
| `CUSTOM_MODEL_TIMEOUT_SECONDS` | `600` | Optional global timeout in seconds for external model completion requests (default: 10 minutes). |
| `CUSTOM_MODEL_TIMEOUT_MS` | *(empty)* | Optional global timeout in milliseconds (overrides `CUSTOM_MODEL_TIMEOUT_SECONDS`). |
| `ENABLE_TRANSLATION_PROXY` | `true` | Enables the internal translation proxy (port `4405`) by default for model tier overrides (`pro` → Gemini 4 Argon) and custom model injection. |

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
  jklinker/antigravity:latest setup
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
| **Google Antigravity UI** | `/` | Main chat interface. Injected with **Custom Models**, **Sidecar Manager**, **Web IDE**, and **Host Terminal** sidebar buttons. | Protected 🔒 |
| **Custom Models** | `/models` | Web UI for configuring Anthropic, OpenAI, or local Ollama endpoints in Antigravity's model selector. | Protected 🔒 |
| **Sidecar Manager** | `/sidecars` | Web UI for defining, scheduling, and monitoring background sidecars and recurring agent prompts. | Protected 🔒 |
| **VS Code Web IDE** | `/ide/` | Full-featured VS Code in the browser for viewing and editing raw project files in `/workspace`. | Protected 🔒 |
| **Host Web Terminal** | `/terminal/` | Web terminal running interactive SSH sessions directly on the host machine (manage Docker, run system commands, git, etc.). | Protected 🔒 |
| **Health & Service Status** | `/status` | Real-time health check endpoint for monitoring service uptime. | **Public / Unauthenticated** 🟢 |

---

## 🧠 External Model Providers (Anthropic, OpenAI, Ollama)

`antigravity-docker` includes native support for integrating external model
providers directly into Antigravity's primary agent harness (terminal sandbox,
file diff engine, live artifacts, and subagents).

Access the configuration page by clicking **Custom Models** in the left
navigation pane of the Antigravity UI or navigating directly to `/models`.

### Supported Providers & Protocols:
- **Anthropic Messages API**: Connect Anthropic models via your Anthropic
  API key (`sk-ant-...`). Thinking blocks stream directly into
  Antigravity's collapsible Thoughts drawer.
- **OpenAI & OpenAI-Compatible Endpoints**: Connect official OpenAI models
  or compatible self-hosted endpoints such as local Ollama, vLLM, or
  DeepSeek.

### Key Features:
- **Dynamic Dropdown Injection**: Enabled external models are automatically
  injected into Antigravity's model selector without DOM scraping or browser
  extensions.
- **Thinking Level Expansion**: Models configured with thinking capability
  automatically expand into **Low**, **Medium**, and **High** thinking levels
  in the UI model picker. Antigravity groups them under the base model name
  with an interactive effort flyout, mapping the selection to Anthropic token
  budgets or OpenAI reasoning effort.
- **Transparent Reverse Proxy**: Standard Gemini models pass directly through
  to Google CloudCode with zero translation overhead or latency penalty.
- **Instant Fallback**: If an external provider key expires or rate limits,
  switch to any standard Gemini model in the dropdown for immediate,
  zero-downtime execution.
- **Encrypted Local Persistence**: External endpoints and credentials are
  persisted in `~/.gemini/config/custom_models.json` on the mounted volume.
  API keys are securely masked in the web UI.

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
- **Plugin Sidecars & Binaries**: Automatically discovers sidecars packaged
  within plugins (`<plugin folder>/sidecars/<sidecar name>/sidecar.json`),
  namespacing them as `<plugin-name>/<sidecar-name>`. Adjacent executable
  binaries and companion scripts residing beside `sidecar.json` can be executed
  directly via relative paths or command name (automatically prepended to
  `PATH`).
- **Spec-Compliant Persistence**: Sidecar configurations are saved to
  `~/.gemini/config/sidecars/<id>/sidecar.json` and enabled states are stored in
  `~/.gemini/config/config.json`.
- **Comprehensive Logging**: Sidecar output is written to
  `~/.gemini/antigravity/sidecar_data/<id>/logs/` and runtime events appear
  directly in `docker compose logs` for debugging.
- **Model Selection & Defaults**: Sidecars can specify their preferred model
  tier (`flash`, `pro`, or `flash_lite`) via `sidecar.json` or the Web UI.

---

## 🎨 Custom CSS & Responsive UI Enhancements

The web gateway automatically serves `/custom.css` (located in
`proxy/custom.css`) and injects modern mobile and foldable viewport
optimizations into the Antigravity web app:

- **Virtual Keyboard Resizing**: Injects `interactive-widget=resizes-content`
  into the viewport `<meta>` tag and dynamically syncs the visual viewport
  height (`--visual-viewport-height`) via the `VisualViewport` API. Prevents
  on-screen virtual keyboards on mobile devices (e.g., Android Chrome) from
  covering the prompt text entry box, smoothly scrolling the active input into
  view.
- **Foldable Unfolded 50/50 Split**: Detects foldable devices in unfolded mode
  (e.g., Google Pixel Fold, Samsung Galaxy Z Fold) and configures the desktop
  split-pane layout so projects and conversation history occupy the left 50%
  and active conversation/chat occupies the right 50%.
- **Workspace Tools Menu Placement**: Cleanly positions the Workspace Tools
  navigation group (Sidecar Manager, Custom Models, Web IDE, Host Terminal)
  directly under the Customizations section in the sidebar navigation.
- **Top-Right Search & Sidebar Toggle Alignment**: Pushes the conversation
  search and hide-sidebar toggle buttons to the top right corner of the
  floating sidebar window card, keeping application branding separated on
  the left.
- **Sentence Case & Mobile Autocorrect**: Automatically sets and preserves
  `autocapitalize="sentences"`, `autocorrect="on"`, `spellcheck="true"`, and
  `autocomplete="on"` on the message input box so Android and mobile virtual
  keyboards capitalize new sentences and automatically replace typos.
- **Gemini-Style Floating Window Sidebar**: Wraps the sidebar navigation in
  a floating frosted glass card featuring rounded corners, subtle border,
  background blur (`backdrop-filter`), layered drop shadows, and soft ambient
  backdrop lighting when displayed alongside conversations in desktop or
  unfolded modes (while retaining native full-width styling on mobile).
- **Clean Application Branding**: Strips `" CLI"` from the browser tab's
  `<title>`, top-left header branding, and runtime `productName`, presenting a
  clean, unified `"Antigravity"` title across the interface.
- **Touch-Friendly Sidebar Scrolling**: Intercepts accidental drag-and-drop
  conversation reordering on touch interactions and foldable displays, ensuring
  smooth list scrolling while preserving desktop mouse-and-keyboard reordering.
- **Custom User Styles**: Add any custom CSS styling directly to
  `proxy/custom.css`. Styles are served with `no-cache` headers for immediate
  application.

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

## 📦 Image Variants (`latest` vs `slim`)

`antigravity-docker` provides two image targets from the same multi-stage
`Dockerfile`:

| Tag | Target | Uncompressed Size | Included |
| :--- | :--- | :--- | :--- |
| `jklinker/antigravity:latest` | `full` *(default)* | ~2.1 GB | Antigravity CLI (`agy`), Node.js 26 (`npm`, `pnpm`, `yarn`, `bun`), Python 3 (`uv`, `poetry`, `pipenv`, `virtualenv`, `pip`), C/C++ build toolchain (`build-essential`, `-dev` headers), interactive shells/editors (`zsh`, `tmux`, `vim`, `nano`), VS Code Web IDE (`code-server`), and Host Web Terminal (`ttyd`). |
| `jklinker/antigravity:slim` | `slim` | ~800 MB | Core headless dev environment (~62% smaller): Antigravity CLI (`agy`), Node.js 26 (`npm`, `bun`), Python 3 (`venv`, standalone `uv`), `git`, `openssh-client`, `curl`, `jq`, and the Bun/Hono web gateway. Omits `code-server`, `ttyd`, `build-essential`, `-dev` headers, interactive editors/shells, and redundant package managers (`ENABLE_IDE=false` and `ENABLE_TERMINAL=false` by default). |

---

## 🛠️ Building & Pushing to Docker Hub

### Build & Tag Locally

**1. Build the `slim` image (`--target slim`):**
```bash
docker build --target slim -t jklinker/antigravity:slim .
```

**2. Build the full `latest` image (default `full` stage, layers on top of
`slim`):**
```bash
docker build --target full -t jklinker/antigravity:latest .
```

**3. Push both tags to Docker Hub:**
```bash
docker push jklinker/antigravity:slim
docker push jklinker/antigravity:latest
```

> [!TIP]
> **Multi-Platform Build (`linux/amd64` + `linux/arm64`)**: To build and push
> both variants for multiple architectures using Docker Buildx:
> ```bash
> docker buildx build --platform linux/amd64,linux/arm64 --target slim -t jklinker/antigravity:slim --push .
> docker buildx build --platform linux/amd64,linux/arm64 --target full -t jklinker/antigravity:latest --push .
> ```

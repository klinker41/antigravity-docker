# Headless Antigravity Docker Agent with Remote Control

A Docker container to run Google Antigravity in **headless Remote Control mode** on your remote server.

Connect to your server's agent anytime from any device (phone, tablet, laptop) via [antigravity.google](https://antigravity.google) or directly via your reverse proxy / local network on a fixed port (default: `4400`).

---

## 🏗️ Architecture

```
                                  ┌────────────────────────┐
                                  │   Browser / Mobile     │
                                  │ (antigravity.google)   │
                                  └───────────┬────────────┘
                                              │ WebRTC / Cloud Relay
                                              ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  Host Linux Server                                                       │
│                                                                          │
│  ┌────────────────────────────────────────────────────────────────────┐  │
│  │ Antigravity Headless Container (Ubuntu 26.04 / Debian Slim)        │  │
│  │                                                                    │  │
│  │ • agy --remote-control --port 4400 (Fixed Port & Cloud Relay)      │  │
│  │ • Working Directory: /workspace (Mounted Host Git Projects)        │  │
│  │ • Python 3 (pip, venv, uv, poetry)                                 │  │
│  │ • Node.js 26 (npm, pnpm, yarn, bun)                                │  │
│  │ • Docker CLI + Compose Plugin                                      │  │
│  │ • Optional Web Terminal (ttyd) for browser onboarding              │  │
│  └───────────────────┬──────────────────────────────┬─────────────────┘  │
│                      │                              │                    │
│                      │ Mounts Workspace             │ Controls via       │
│                      ▼                              │ /var/run/docker.sock
│  ┌──────────────────────────────────────────┐       │                    │
│  │ Host Workspace / Git Projects            │       ▼                    │
│  │ (e.g. /home/ubuntu/projects)             │  ┌──────────────────────┐  │
│  │ • git clone repo1                        │  │ Host Docker Daemon   │  │
│  │ • git clone repo2                        │  │ (Builds & runs apps) │  │
│  └──────────────────────────────────────────┘  └──────────────────────┘  │
└──────────────────────────────────────────────────────────────────────────┘
```

---

## ⚡ Features & Modern Stack

- **Fixed Port Support (`AGY_PORT=4400`)**: Binds `agy` to a fixed port rather than random ports, making reverse proxies and local network access predictable.
- **Base Image**: **Ubuntu 26.04 LTS** (default) or **Debian Slim** (`debian:bookworm-slim`), providing full glibc compatibility for pre-compiled Python wheels and Node native addons.
- **Google Antigravity Remote Control (`agy --remote-control`)**: Outbound cloud relay connectivity and direct local web interface.
- **Node.js 26**: Latest Node.js release line with `npm`, `pnpm`, `yarn`, and `bun`.
- **Python Modern Stack**: Python 3 with `pip`, `venv`, ultra-fast `uv`, `poetry`, and `build-essential`.
- **Git Projects Workspace**: Dedicated workspace mounted at `/workspace` for cloning, building, and managing Git codebases.
- **Host Docker Management**: Mounts `/var/run/docker.sock` with dynamic GID alignment so the agent can build and deploy containers directly on the host server.
- **Persistent State**: OAuth tokens, configs, agent logs, and workspace files persist across container restarts in `./data/`.

---

## 🚀 Quickstart Guide

### Step 1: Copy Files & Configure `.env`
Copy this directory to your remote server:
```bash
cp .env.example .env
```
Edit `.env` to configure your instance name and workspace directory:
```ini
BASE_IMAGE=ubuntu:26.04
RC_NAME=my-server-agent
AGY_PORT=4400
AGY_PORT_BINDING=4400

# Set this to where your Git repositories are stored on your server
WORKSPACE_DIR=/home/ubuntu/projects
```

### Step 2: One-Time Google OAuth Authentication
Run the interactive setup command:
```bash
./scripts/setup-auth.sh
# Or directly via docker compose:
docker compose run --rm antigravity-agent setup
```
1. A Google sign-in URL will appear in the terminal.
2. Open the URL in your browser on any device.
3. Sign in to your Google Account.
4. Your token is automatically saved into `./data/gemini/` on the host.

### Step 3: Start the Daemon
Start the agent container in the background:
```bash
docker compose up -d
```
Check the logs to verify it is connected:
```bash
docker compose logs -f antigravity-agent
```

### Step 4: Accessing the Instance
You can connect in two ways:
1. **Via Cloud Dashboard**: Visit **[https://antigravity.google](https://antigravity.google)** and select your instance (`my-server-agent`) from the machine dropdown.
2. **Via Reverse Proxy / Local Network**: Point your reverse proxy to `127.0.0.1:4400` or open `http://<your-server-ip>:4400` directly.

---

## 📂 Git & Host Docker Integration

### Working with Git Projects
- Inside the container, the default working directory is `/workspace` (which maps to your `WORKSPACE_DIR` on the host).
- You can ask the remote agent to `git clone`, edit, commit, and push repositories within `/workspace`.
- To enable authenticated git push/pull with private GitHub/GitLab repositories, you can optionally uncomment the SSH / Git config mounts in `docker-compose.yml`:
  ```yaml
  volumes:
    - ~/.gitconfig:/home/developer/.gitconfig:ro
    - ~/.ssh:/home/developer/.ssh:ro
  ```

### Deploying Containers on the Host
Because the container controls the **host** Docker daemon, volume paths passed to `docker run -v` or `docker compose` refer to the host path.
- The environment variable `HOST_WORKSPACE_PATH` (set to `WORKSPACE_DIR`) allows the agent to run:
  ```bash
  docker run -d -p 8000:8000 -v ${HOST_WORKSPACE_PATH}/my-project:/app my-project-image
  ```

---

## 🌐 Optional: Browser Web Terminal (`ttyd`)

If you want to access the container's shell directly from a web browser without SSH (for initial setup or maintenance):

1. In `.env`, set:
   ```ini
   ENABLE_WEB_TERMINAL=true
   WEB_TERMINAL_USER=admin
   WEB_TERMINAL_PASS=your_secret_password
   ```
2. Restart the container:
   ```bash
   docker compose up -d
   ```
3. Access the terminal at `http://<your-server-ip>:7681`.

---

## 📂 File Structure

```
.
├── Dockerfile                  # Base container image definition (Ubuntu 26.04 / Debian Slim)
├── docker-compose.yml          # Container orchestration & volume bindings
├── entrypoint.sh               # Startup script: socket permissions & launch modes
├── .env.example                # Configuration parameters template
├── README.md                   # Documentation & setup guide
└── scripts/
    ├── setup-auth.sh           # Interactive OAuth login helper
    └── test-host-docker.sh     # System & Docker verification script
```

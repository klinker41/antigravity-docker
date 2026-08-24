# Headless Antigravity Docker Agent with Remote Control

Run Google Antigravity in **headless Remote Control mode** on your server. Connect to your agent from any browser via your reverse proxy or local network with built-in password protection.

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
      - RC_NAME=<remote-control-name>
      - AGY_PORT=4400
      - AUTH_PASSWORD=<password-for-login>
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - <location-of-projects>:/workspace
      - <location-of-config>:/home/developer/.gemini
      - <home-folder>/.gitconfig:/home/developer/.gitconfig:ro
      - <home-folder>/.ssh:/home/developer/.ssh:ro
```

---

## ⚙️ Configuration

### Environment Variables

| Variable | Default | Description |
| :--- | :--- | :--- |
| `RC_NAME` | `server-agent` | Identifier name for this server instance. |
| `AGY_PORT` | `4400` | Port exposed by the built-in web gateway. |
| `AUTH_PASSWORD` | *(empty)* | Optional password to protect web access. When set, prompts for login and remembers session for 30 days. |

### Volumes

| Volume | Container Path | Description |
| :--- | :--- | :--- |
| `/var/run/docker.sock` | `/var/run/docker.sock` | Allows Antigravity to build and manage containers on the host Docker daemon. |
| `<location-of-projects>` | `/workspace` | Host directory where your Git repositories and codebases live. |
| `<location-of-config>` | `/home/developer/.gemini` | Host directory where Antigravity OAuth tokens and preferences persist. |
| `<home-folder>/.gitconfig` | `/home/developer/.gitconfig:ro` | *(Optional)* Mounts host Git configuration for authenticated commits. |
| `<home-folder>/.ssh` | `/home/developer/.ssh:ro` | *(Optional)* Mounts host SSH keys for private Git operations (GitHub/GitLab). |

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
3. Your OAuth token is automatically saved into your persistent config directory on the host.

### Step 2: Start the Agent
```bash
docker compose up -d
```

---

## 🌐 Accessing the Agent

Navigate to `http://<your-server-ip>:4400` in your browser (or through your reverse proxy). If configured, enter your `AUTH_PASSWORD` on the login screen to unlock your session for 30 days.

---

## 🛠️ Building & Pushing to Docker Hub

If you want to build the Docker image from source and push it to Docker Hub:

```bash
docker build -t jklinker/antigravity-docker:latest .
docker push jklinker/antigravity-docker:latest
```

> [!TIP]
> **Multi-Platform Build**: To build and push for multiple architectures (such as `linux/amd64` and `linux/arm64` for Apple Silicon or ARM servers) using Docker Buildx:
> ```bash
> docker buildx build --platform linux/amd64,linux/arm64 -t jklinker/antigravity-docker:latest --push .
> ```

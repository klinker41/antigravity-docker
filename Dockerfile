ARG BASE_IMAGE=ubuntu:26.04
FROM ${BASE_IMAGE} AS slim

LABEL maintainer="Jake Klinker" \
      description="Headless Google Antigravity Remote Control Agent (Slim Dev)"

# Prevent interactive prompts during apt installs
ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    SHELL=/bin/bash

# 1. Install core base utilities and system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    gnupg \
    git \
    openssh-client \
    jq \
    sudo \
    procps \
    iproute2 \
    unzip \
    tar \
    xz-utils \
    gosu \
    && rm -rf /var/lib/apt/lists/*

# 2. Install Node.js 26 and Bun runtime
RUN curl -fsSL https://deb.nodesource.com/setup_26.x | bash - && \
    apt-get install -y --no-install-recommends nodejs && \
    npm install -g bun && \
    npm cache clean --force && \
    rm -rf /var/lib/apt/lists/* /root/.npm

# 3. Install Python 3, venv, and standalone uv package manager
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-venv \
    python-is-python3 \
    && rm -rf /var/lib/apt/lists/* && \
    curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR="/usr/local/bin" INSTALLER_NO_MODIFY_PATH=1 sh

# 4. Create non-root developer user
ARG USERNAME=developer
ARG USER_UID=1000
ARG USER_GID=1000

RUN if id -u ubuntu >/dev/null 2>&1; then userdel -f -r ubuntu || true; fi && \
    if getent group ubuntu >/dev/null 2>&1; then groupdel ubuntu || true; fi && \
    if ! getent group ${USER_GID} >/dev/null 2>&1; then \
        groupadd --gid ${USER_GID} ${USERNAME}; \
    else \
        groupmod -n ${USERNAME} $(getent group ${USER_GID} | cut -d: -f1); \
    fi && \
    if ! id -u ${USER_UID} >/dev/null 2>&1; then \
        useradd --uid ${USER_UID} --gid ${USER_GID} -m -s /bin/bash ${USERNAME}; \
    else \
        usermod -l ${USERNAME} -d /home/${USERNAME} -m $(id -un ${USER_UID}); \
    fi

# 5. Install Antigravity CLI (agy) for developer user
USER ${USERNAME}
ENV HOME=/home/${USERNAME}
WORKDIR /home/${USERNAME}

RUN mkdir -p /home/${USERNAME}/.local/bin && \
    curl -fsSL https://antigravity.google/cli/install.sh | bash -s -- --dir /home/${USERNAME}/.local/bin

# Add ~/.local/bin and package manager binaries to PATH
ENV PATH="/home/${USERNAME}/.gemini/antigravity-cli/bin:/home/${USERNAME}/.local/bin:/home/${USERNAME}/.cargo/bin:/home/${USERNAME}/.local/share/pnpm:${PATH}"
ENV AGY_ENABLE_HUB="true" \
    ENABLE_IDE="false" \
    ENABLE_TERMINAL="false"

# Create required directories for persistent storage and workspace
USER root
RUN mkdir -p /home/${USERNAME}/.gemini \
             /workspace && \
    chown -R ${USERNAME}:${USERNAME} /home/${USERNAME} /workspace

COPY assets/ /usr/local/share/antigravity/assets/

COPY package.json /usr/local/bin/package.json
COPY bun.lock /usr/local/bin/bun.lock
RUN cd /usr/local/bin && bun install --production --frozen-lockfile && rm -rf /root/.bun

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
COPY proxy/ /usr/local/bin/
RUN chmod +x /usr/local/bin/entrypoint.sh /usr/local/bin/auth-proxy.js /usr/local/bin/sidecar-manager.js /usr/local/bin/translation-proxy.js

WORKDIR /workspace

EXPOSE 4400

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["daemon"]

# ==============================================================================
# Full Image Stage (Default): Adds C/C++ build toolchain, extra package managers,
# interactive shells/editors, VS Code Web IDE (code-server), and Web Terminal (ttyd)
# ==============================================================================
FROM slim AS full

ARG USERNAME=developer

LABEL maintainer="Jake Klinker" \
      description="Headless Google Antigravity Remote Control Agent with Python, Node.js 26, VS Code Web IDE, and Host Web Terminal"

USER root

# 1. Install build toolchain, headers, interactive editors/shells, and extra package managers
RUN apt-get update && apt-get install -y --no-install-recommends \
    wget \
    lsb-release \
    tmux \
    zsh \
    vim \
    nano \
    build-essential \
    pkg-config \
    libssl-dev \
    libffi-dev \
    iputils-ping \
    net-tools \
    python3-pip \
    python3-dev \
    && rm -rf /var/lib/apt/lists/* && \
    npm install -g pnpm yarn && \
    npm cache clean --force && \
    rm -rf /root/.npm && \
    pip install --no-cache-dir --break-system-packages --ignore-installed poetry pipenv virtualenv

# 2. Install code-server (VS Code Web IDE) and ttyd (Web Terminal)
RUN curl -fsSL https://code-server.dev/install.sh | sh && \
    ARCH="$(uname -m)" && \
    case "$ARCH" in \
        x86_64) TTYD_ARCH="x86_64" ;; \
        aarch64|arm64) TTYD_ARCH="aarch64" ;; \
        *) echo "Unsupported arch: $ARCH" && exit 1 ;; \
    esac && \
    curl -fsSL "https://github.com/tsl0922/ttyd/releases/download/1.7.7/ttyd.${TTYD_ARCH}" -o /usr/local/bin/ttyd && \
    chmod +x /usr/local/bin/ttyd

# 3. Configure code-server directories, branding icons, and host-terminal wrapper
RUN mkdir -p /home/${USERNAME}/.local/share/code-server \
             /home/${USERNAME}/.config/code-server && \
    chown -R ${USERNAME}:${USERNAME} /home/${USERNAME}/.local /home/${USERNAME}/.config && \
    if [ -d /usr/lib/code-server/src/browser/media ]; then \
        cp /usr/local/share/antigravity/assets/favicon.svg /usr/lib/code-server/src/browser/media/favicon.svg && \
        cp /usr/local/share/antigravity/assets/favicon.svg /usr/lib/code-server/src/browser/media/favicon-dark-support.svg && \
        cp /usr/local/share/antigravity/assets/favicon.ico /usr/lib/code-server/src/browser/media/favicon.ico && \
        cp /usr/local/share/antigravity/assets/pwa-icon-192.png /usr/lib/code-server/src/browser/media/pwa-icon-192.png 2>/dev/null || true && \
        cp /usr/local/share/antigravity/assets/pwa-icon-512.png /usr/lib/code-server/src/browser/media/pwa-icon-512.png 2>/dev/null || true; \
    fi && \
    if [ -d /usr/lib/code-server/lib/vscode/resources/server ]; then \
        cp /usr/local/share/antigravity/assets/favicon.ico /usr/lib/code-server/lib/vscode/resources/server/favicon.ico 2>/dev/null || true; \
    fi

COPY scripts/host-terminal.sh /usr/local/bin/host-terminal.sh
RUN chmod +x /usr/local/bin/host-terminal.sh

ENV ENABLE_IDE="true" \
    ENABLE_TERMINAL="true"

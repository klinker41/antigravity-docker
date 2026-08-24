FROM ubuntu:24.04

LABEL maintainer="Antigravity Team" \
      description="Headless Google Antigravity Remote Control Agent with Python, Node.js, and Host Docker orchestration"

# Prevent interactive prompts during apt installs
ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    SHELL=/bin/bash

# 1. Install base utilities and system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    wget \
    gnupg \
    lsb-release \
    git \
    openssh-client \
    jq \
    tmux \
    zsh \
    vim \
    nano \
    sudo \
    build-essential \
    pkg-config \
    libssl-dev \
    libffi-dev \
    procps \
    iputils-ping \
    iproute2 \
    net-tools \
    unzip \
    tar \
    xz-utils \
    gosu \
    && rm -rf /var/lib/apt/lists/*

# 2. Install Docker CLI and Docker Compose plugin (Official Docker repository)
RUN install -m 0755 -d /etc/apt/keyrings && \
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg && \
    chmod a+r /etc/apt/keyrings/docker.gpg && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" > /etc/apt/sources.list.d/docker.list && \
    apt-get update && apt-get install -y --no-install-recommends \
    docker-ce-cli \
    docker-compose-plugin \
    docker-buildx-plugin \
    && rm -rf /var/lib/apt/lists/*

# 3. Install Node.js LTS (v22.x) and Package Managers (npm, pnpm, yarn, bun)
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && \
    apt-get install -y --no-install-recommends nodejs && \
    corepack enable && \
    npm install -g pnpm yarn bun && \
    rm -rf /var/lib/apt/lists/*

# 4. Install Python 3.12, pip, venv, and modern Python package managers (uv, poetry)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    python3-venv \
    python3-dev \
    python-is-python3 \
    && rm -rf /var/lib/apt/lists/* && \
    pip install --no-cache-dir --break-system-packages uv poetry pipenv virtualenv

# 5. Install ttyd for optional browser-based web terminal setup/fallback
RUN ARCH=$(dpkg --print-architecture) && \
    case "$ARCH" in \
        amd64) TTYD_ARCH="x86_64" ;; \
        arm64) TTYD_ARCH="aarch64" ;; \
        *) TTYD_ARCH="$ARCH" ;; \
    esac && \
    curl -fsSL "https://github.com/tsl0922/ttyd/releases/download/1.7.7/ttyd.${TTYD_ARCH}" -o /usr/local/bin/ttyd && \
    chmod +x /usr/local/bin/ttyd

# 6. Create non-root developer user with sudo privileges
ARG USERNAME=developer
ARG USER_UID=1000
ARG USER_GID=1000

RUN groupadd --gid ${USER_GID} ${USERNAME} && \
    useradd --uid ${USER_UID} --gid ${USER_GID} -m -s /bin/bash ${USERNAME} && \
    echo "${USERNAME} ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers.d/${USERNAME} && \
    chmod 0440 /etc/sudoers.d/${USERNAME}

# 7. Install Antigravity CLI (agy) for developer user
USER ${USERNAME}
ENV HOME=/home/${USERNAME}
WORKDIR /home/${USERNAME}

RUN mkdir -p /home/${USERNAME}/.local/bin && \
    curl -fsSL https://antigravity.google/cli/install.sh | bash -s -- --dir /home/${USERNAME}/.local/bin

# Add ~/.local/bin and package manager binaries to PATH
ENV PATH="/home/${USERNAME}/.local/bin:/home/${USERNAME}/.cargo/bin:/home/${USERNAME}/.local/share/pnpm:${PATH}"

# Create required directories for persistent storage and workspace
USER root
RUN mkdir -p /home/${USERNAME}/.gemini \
             /home/${USERNAME}/.antigravity \
             /workspace && \
    chown -R ${USERNAME}:${USERNAME} /home/${USERNAME} /workspace

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

WORKDIR /workspace

EXPOSE 7681

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["daemon"]

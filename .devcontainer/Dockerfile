FROM mcr.microsoft.com/devcontainers/typescript-node:24-trixie

USER root

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    build-essential \
    ca-certificates \
    clang \
    curl \
    libssl-dev \
    libudev-dev \
    pkg-config \
  && rm -rf /var/lib/apt/lists/*

ENV NVM_DIR="/usr/local/share/nvm"

RUN su node -c "source /usr/local/share/nvm/nvm.sh && nvm install 24.22.1 && nvm alias default 24.22.1 && nvm use 24.22.1 && test -x /usr/local/share/nvm/versions/node/v24.22.1/bin/node && test \"\$(node --version)\" = \"v24.22.1\""

ENV PATH="/usr/local/share/nvm/versions/node/v24.22.1/bin:${PATH}"

USER node

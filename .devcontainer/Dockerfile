FROM mcr.microsoft.com/devcontainers/typescript-node:24-bookworm

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

USER node
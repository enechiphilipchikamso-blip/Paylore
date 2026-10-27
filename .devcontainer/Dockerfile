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

# The upstream TypeScript/Node image does not provide Rustup. Install Rustup for
# the non-root development user so setup.sh can pin the project toolchain.
RUN su node -c 'curl --proto "=https" --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --no-modify-path --profile minimal --default-toolchain none'

ENV CARGO_HOME="/home/node/.cargo"
ENV RUSTUP_HOME="/home/node/.rustup"
ENV PATH="/home/node/.cargo/bin:/home/node/.avm/bin:/home/node/.local/share/solana/install/active_release/bin:/usr/local/share/nvm/versions/node/v24.22.1/bin:${PATH}"

USER node

# ShroudVeil hosted demo: one container runs the whole stack
# (Bitcoin Core regtest + LNbits/FakeWallet + the app) in demo mode.
# Build:  docker build -t shroudveil .
# Run:    docker run -p 8799:8799 shroudveil
# Render: web service, runtime = docker, plan = free. Render sets $PORT;
# the start process serves the app on it and keeps the chain and LNbits
# on loopback inside the container.
FROM python:3.12-slim-bookworm

ENV DEBIAN_FRONTEND=noninteractive \
    SV_BITCOIN_BIN=/opt/bitcoin/bin \
    SV_LNBITS_VENV=/opt/lnbits-venv \
    HOME=/root

# curl + xz for the Node and Bitcoin Core tarballs; procps for pkill,
# used by the start process when it restarts LNbits during first-install.
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates xz-utils procps \
 && rm -rf /var/lib/apt/lists/*

# Node.js 24 (same major as the local build environment)
RUN curl -fsSL https://nodejs.org/dist/v24.22.1/node-v24.22.1-linux-x64.tar.xz \
  | tar -xJ -C /usr/local --strip-components=1

# Bitcoin Core 28.1 (same version as the local tools/ copy)
RUN mkdir -p /opt/bitcoin \
 && curl -fsSL https://bitcoincore.org/bin/bitcoin-core-28.1/bitcoin-28.1-x86_64-linux-gnu.tar.gz \
  | tar -xz -C /opt/bitcoin --strip-components=1

# LNbits 1.7.1, with the bitstring pin the spike proved
# (bolt11 needs bitstring<4; the conflict only affects the Core Lightning
# backend, which this design does not use).
RUN python3 -m venv /opt/lnbits-venv \
 && /opt/lnbits-venv/bin/pip install --no-cache-dir "lnbits==1.7.1" "bitstring==3.1.9"

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

EXPOSE 8799
CMD ["bash", "scripts/render-start.sh"]

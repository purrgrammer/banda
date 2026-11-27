# Micro-spike image: Node 24 on Debian bookworm with D-Bus, gnome-keyring (Secret Service), secret-tool and Xvfb.
# the multi-arch index digest recorded on 2026-11-23 (node v24.22.3 inside)
FROM node:24-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54
RUN apt-get update \
 && apt-get install -y --no-install-recommends dbus gnome-keyring libsecret-tools procps xvfb \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/spike
COPY package.json ./
RUN npm install --no-audit --no-fund
COPY kc.mjs hang.mjs linux.sh audit-deps.mjs ./

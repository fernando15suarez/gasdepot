# rigs-dashboard — read-only Gas Town status webpage.
#
# Pinned small node base. The dashboard reaches Gas Town state by running
# `docker exec ${GT_TARGET_CONTAINER} gt|bd|tmux ...` against the sibling
# container, so this image only needs node + the docker CLI.
ARG NODE_VERSION=22
ARG DEBIAN_VERSION=bookworm

FROM node:${NODE_VERSION}-${DEBIAN_VERSION}-slim AS rigs-dashboard

ENV DEBIAN_FRONTEND=noninteractive \
    NODE_ENV=production \
    DASHBOARD_PORT=3338

# docker CLI only (no daemon). The dashboard talks to the host docker socket
# so it can `docker exec` into the sibling gastown container. tmux is invoked
# via that exec, so we don't need it in the dashboard image.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        gnupg \
    && install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://download.docker.com/linux/debian/gpg \
        -o /etc/apt/keyrings/docker.asc \
    && chmod a+r /etc/apt/keyrings/docker.asc \
    && codename="$(. /etc/os-release && echo "$VERSION_CODENAME")" \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian ${codename} stable" \
        > /etc/apt/sources.list.d/docker.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends docker-ce-cli \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/rigs-dashboard

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY server.js ./
COPY public ./public

EXPOSE 3338

CMD ["node", "server.js"]

# Gas Town Starter Kit — single-container image
#
# Contains the pinned Gas Town toolchain plus TeleTalk and Crow source vendored
# at build time. User data (repos, Dolt DBs, Claude config, logs, .env) lives
# on mounted volumes so it survives rebuilds. See docker-compose.yml.
#
# Tool pins — bump deliberately, test, then commit the new pins together.
ARG NODE_VERSION=22
ARG PYTHON_VERSION=3.12
ARG DEBIAN_VERSION=bookworm

ARG DOLT_VERSION=1.86.1
ARG BD_VERSION=1.0.3
ARG BD_REPO=gastownhall/beads
ARG GT_VERSION=0.12.0
ARG CLAUDE_VERSION=2.1.117

# Local voice transcription. WHISPER_REF pins whisper.cpp; the binary and
# WHISPER_MODEL are baked into the runtime layer so cloners get voice
# support out of the box without any additional setup.
ARG WHISPER_REF=v1.7.5
ARG WHISPER_MODEL=ggml-tiny.en.bin

# GID for the in-container `docker` group. Must match the GID that owns
# /var/run/docker.sock on the host or `docker` calls inside the container
# will hit EACCES. 988 is the default Debian/Ubuntu assignment for the
# docker package; pass `--build-arg DOCKER_GID=$(stat -c '%g' /var/run/docker.sock)`
# at build time if your host differs. The entrypoint logs a warning at
# boot if the live socket GID doesn't match the group GID baked in here.
ARG DOCKER_GID=988

# Upstream repos vendored at build time (not git submodules).
ARG TELETALK_REPO=https://github.com/fernando15suarez/teletalk.git
ARG CROW_REPO=https://github.com/fernando15suarez/crow.git
ARG TELETALK_REF=main
ARG CROW_REF=main

# -----------------------------------------------------------------------------
# Stage 1 — fetch upstream source for TeleTalk and Crow. Doing this in a
# separate stage keeps the final image clean of git metadata.
# -----------------------------------------------------------------------------
FROM debian:${DEBIAN_VERSION}-slim AS sources
ARG TELETALK_REPO
ARG CROW_REPO
ARG TELETALK_REF
ARG CROW_REF

RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /src
RUN git clone --depth 1 --branch "${TELETALK_REF}" "${TELETALK_REPO}" teletalk \
    && rm -rf teletalk/.git
RUN git clone --depth 1 --branch "${CROW_REF}" "${CROW_REPO}" crow \
    && rm -rf crow/.git

# -----------------------------------------------------------------------------
# Stage 1b — build whisper.cpp and download a voice model. Build artefacts
# are copied into the runtime stage; the toolchain itself stays out of it.
# -----------------------------------------------------------------------------
FROM debian:${DEBIAN_VERSION}-slim AS whisper-builder
ARG WHISPER_REF
ARG WHISPER_MODEL

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        cmake \
        curl \
        g++ \
        git \
        make \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build
RUN git clone --depth 1 --branch "${WHISPER_REF}" https://github.com/ggerganov/whisper.cpp /build/whisper.cpp \
    && cd /build/whisper.cpp \
    && cmake -B build -DCMAKE_BUILD_TYPE=Release \
    && cmake --build build -j --config Release --target whisper-cli \
    && bash ./models/download-ggml-model.sh "$(echo "${WHISPER_MODEL}" | sed -E 's/^ggml-(.+)\.bin$/\1/')"

# -----------------------------------------------------------------------------
# Stage 2 — runtime image. Node + Python + the Gas Town toolchain.
# -----------------------------------------------------------------------------
FROM node:${NODE_VERSION}-${DEBIAN_VERSION}-slim AS runtime

ARG DOLT_VERSION
ARG BD_VERSION
ARG BD_REPO
ARG GT_VERSION
ARG CLAUDE_VERSION
ARG PYTHON_VERSION
ARG DOCKER_GID

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    GASTOWN_HOME=/gastown \
    PATH="/gastown/wizard:/usr/local/bin:${PATH}"

# --- OS packages -----------------------------------------------------------
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        ffmpeg \
        git \
        gnupg \
        jq \
        libatomic1 \
        locales \
        python3 \
        python3-pip \
        python3-venv \
        sudo \
        tmux \
        tzdata \
        vim-tiny \
    && rm -rf /var/lib/apt/lists/* \
    && locale-gen C.UTF-8

# --- dolt ------------------------------------------------------------------
# Prebuilt amd64 binary from the upstream release. If you're on arm64, rebuild
# with `docker buildx` and dolt will be installed from the arm64 asset.
RUN set -eux; \
    arch="$(dpkg --print-architecture)"; \
    case "${arch}" in \
      amd64) dolt_arch=amd64 ;; \
      arm64) dolt_arch=arm64 ;; \
      *) echo "unsupported arch: ${arch}"; exit 1 ;; \
    esac; \
    curl -fsSL -o /tmp/dolt.tgz \
      "https://github.com/dolthub/dolt/releases/download/v${DOLT_VERSION}/dolt-linux-${dolt_arch}.tar.gz"; \
    tar -xzf /tmp/dolt.tgz -C /tmp; \
    mv "/tmp/dolt-linux-${dolt_arch}/bin/dolt" /usr/local/bin/dolt; \
    chmod +x /usr/local/bin/dolt; \
    rm -rf /tmp/dolt*; \
    dolt version

# --- bd (beads) ------------------------------------------------------------
# Upstream ships a GoReleaser tarball (beads_<ver>_linux_<goarch>.tar.gz) that
# contains the bd binary. Extract and install to /usr/local/bin/bd.
RUN set -eux; \
    arch="$(dpkg --print-architecture)"; \
    case "${arch}" in \
      amd64) bd_arch=amd64 ;; \
      arm64) bd_arch=arm64 ;; \
      *) echo "unsupported arch: ${arch}"; exit 1 ;; \
    esac; \
    tmpdir="$(mktemp -d)"; \
    curl -fsSL -o "${tmpdir}/bd.tgz" \
      "https://github.com/${BD_REPO}/releases/download/v${BD_VERSION}/beads_${BD_VERSION}_linux_${bd_arch}.tar.gz"; \
    tar -xzf "${tmpdir}/bd.tgz" -C "${tmpdir}"; \
    mv "${tmpdir}/bd" /usr/local/bin/bd; \
    chmod +x /usr/local/bin/bd; \
    rm -rf "${tmpdir}"; \
    bd --version

# --- gt (Gas Town CLI) -----------------------------------------------------
# Published as an npm package. Pinning to a specific version keeps surprises
# out of image rebuilds.
RUN npm install -g "@gastown/gt@${GT_VERSION}" \
    && gt --version

# --- whisper.cpp (local voice transcription) ------------------------------
# Binary + model copied from the builder stage; ffmpeg comes from apt above.
# WHISPER_MODEL is the filename only — the path is fixed at /opt/whisper/.
ARG WHISPER_MODEL
COPY --from=whisper-builder /build/whisper.cpp/build/bin/whisper-cli /usr/local/bin/whisper-cli
COPY --from=whisper-builder /build/whisper.cpp/models/${WHISPER_MODEL} /opt/whisper/models/${WHISPER_MODEL}
# Whisper.cpp ships its libs alongside the binary; copy them into a path
# the dynamic linker already searches so we don't have to set LD_LIBRARY_PATH.
COPY --from=whisper-builder /build/whisper.cpp/build/src/libwhisper.so* /usr/local/lib/
COPY --from=whisper-builder /build/whisper.cpp/build/ggml/src/libggml*.so* /usr/local/lib/
RUN ldconfig && whisper-cli --help >/dev/null 2>&1 && echo "whisper-cli installed"

# --- docker CLI ------------------------------------------------------------
# Just the client + compose plugin; no daemon. The container talks to the
# host's docker daemon over the bind-mounted /var/run/docker.sock (see
# docker-compose.yml). This grants effective root-on-host to anyone in the
# container, justified by branch protection on main + PR-only flow + the
# operator already trusting the container with full GitHub PAT access.
# See docs/docker-access.md for the full trust analysis.
RUN set -eux; \
    install -m 0755 -d /etc/apt/keyrings; \
    curl -fsSL https://download.docker.com/linux/debian/gpg \
        -o /etc/apt/keyrings/docker.asc; \
    chmod a+r /etc/apt/keyrings/docker.asc; \
    codename="$(. /etc/os-release && echo "${VERSION_CODENAME}")"; \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian ${codename} stable" \
        > /etc/apt/sources.list.d/docker.list; \
    apt-get update; \
    apt-get install -y --no-install-recommends docker-ce-cli docker-compose-plugin; \
    rm -rf /var/lib/apt/lists/*; \
    docker --version; \
    docker compose version

# --- non-root user ---------------------------------------------------------
# All runtime work happens as `gastown` (uid 1000). Matches typical host uid
# so bind-mounted volumes don't end up root-owned.
#
# The node base image ships a `node` user at UID/GID 1000, so we rename it
# to `gastown` rather than trying to create a fresh one (which would fail
# with EEXIST). The conditional covers future base images that don't ship
# a uid-1000 user.
#
# We also pre-create the volume mount points (/gastown/logs, repos,
# .dolt-data) so that when Docker initializes a named volume on first run,
# it copies the correct ownership from the image layer. Without this, a
# fresh named volume mounts as root:root and the gastown user can't write.
#
# This block comes BEFORE the claude install so we can run the installer as
# the gastown user — the script writes to $HOME/.local and ignores any
# override flags, so installing as root lands the binary at /root/.local
# which is 0700 and unreadable by gastown.
RUN set -eux; \
    if getent group 1000 >/dev/null 2>&1; then \
      groupmod -n gastown "$(getent group 1000 | cut -d: -f1)"; \
    else \
      groupadd -g 1000 gastown; \
    fi; \
    if id 1000 >/dev/null 2>&1; then \
      usermod -l gastown -d /home/gastown -m -s /bin/bash -g gastown "$(getent passwd 1000 | cut -d: -f1)"; \
    else \
      useradd -m -u 1000 -g gastown -s /bin/bash gastown; \
    fi; \
    if ! getent group docker >/dev/null 2>&1; then \
      groupadd -g "${DOCKER_GID}" docker; \
    fi; \
    usermod -aG docker gastown; \
    mkdir -p /gastown/logs /gastown/repos /gastown/.dolt-data \
             /home/gastown/.claude /home/gastown/.config; \
    chown -R gastown:gastown /gastown /home/gastown

# --- claude (Claude Code CLI) ---------------------------------------------
# Install AS the gastown user so the binary lands in /home/gastown/.local,
# which is world-traversable (0755 via useradd defaults) unlike /root (0700).
# The install script ignores CLAUDE_INSTALL_DIR and always writes to
# $HOME/.local, so the user it runs as determines where it lands.
USER gastown
RUN set -eux; \
    curl -fsSL https://claude.ai/install.sh | bash -s -- "${CLAUDE_VERSION}"; \
    /home/gastown/.local/bin/claude --version
USER root
RUN ln -sf /home/gastown/.local/bin/claude /usr/local/bin/claude

# --- claude onboarding seed -----------------------------------------------
# Pre-accept Claude Code's first-run onboarding so Mayor doesn't block on an
# interactive theme-picker / OAuth wizard the first time it spawns. Auth
# credentials still come from the host's ~/.claude bind mount; these flags
# only cover the UI onboarding state.
RUN echo '{"hasCompletedOnboarding":true,"bypassPermissionsModeAccepted":true}' \
      > /home/gastown/.claude.json \
    && chown gastown:gastown /home/gastown/.claude.json \
    && chmod 600 /home/gastown/.claude.json

# --- vendored sources ------------------------------------------------------
COPY --from=sources --chown=gastown:gastown /src/teletalk /opt/teletalk
COPY --from=sources --chown=gastown:gastown /src/crow /opt/crow

# --- the starter kit itself -----------------------------------------------
# Everything the wizard needs lives in /gastown. User data mounts land here
# too — see docker-compose.yml for the volume layout.
COPY --chown=gastown:gastown wizard /gastown/wizard
COPY --chown=gastown:gastown entrypoint.sh /gastown/entrypoint.sh
COPY --chown=gastown:gastown .env.example /gastown/.env.example
COPY --chown=gastown:gastown docs /gastown/docs
COPY --chown=gastown:gastown skills /gastown/skills
COPY --chown=gastown:gastown bot /gastown/bot

# Install gt-bot dependencies into the image so the container is self-contained.
# Use --omit=dev to keep the image small; gt-bot has no devDependencies today.
RUN cd /gastown/bot && npm install --omit=dev --no-audit --no-fund

# Materialize the install-gastown skill into the container's Claude config
# directory. Sources live under /gastown/skills/ (plain path, always checked
# in). The entrypoint mirrors the same tree into the user's mounted
# ~/.claude on first run so the host `claude` CLI can use it too.
RUN mkdir -p /gastown/.claude/skills/install-gastown \
    && cp /gastown/skills/install-gastown/SKILL.md /gastown/.claude/skills/install-gastown/SKILL.md

RUN chmod +x /gastown/entrypoint.sh /gastown/wizard/gt-wizard

USER gastown
WORKDIR /gastown

# Dolt server port — see gt/CLAUDE.md for operational notes.
EXPOSE 3307
# gt-bot HTTP API (POST /send, GET /health).
EXPOSE 3335

ENTRYPOINT ["/gastown/entrypoint.sh"]
# Default to daemon mode so `docker compose up -d` boots the whole stack
# (Dolt + HQ + gt-bot + Mayor). The interactive wizard is still available
# via `docker compose run --rm gastown wizard`.
CMD ["daemon"]

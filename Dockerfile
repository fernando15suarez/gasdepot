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
ARG BD_VERSION=1.0.2
ARG BD_REPO=gastownhall/beads
ARG GT_VERSION=0.12.0
ARG CLAUDE_VERSION=2.1.117

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
# Stage 2 — runtime image. Node + Python + the Gas Town toolchain.
# -----------------------------------------------------------------------------
FROM node:${NODE_VERSION}-${DEBIAN_VERSION}-slim AS runtime

ARG DOLT_VERSION
ARG BD_VERSION
ARG BD_REPO
ARG GT_VERSION
ARG CLAUDE_VERSION
ARG PYTHON_VERSION

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

# --- claude (Claude Code CLI) ---------------------------------------------
# Installed via the official install script, pinned to CLAUDE_VERSION.
RUN set -eux; \
    curl -fsSL https://claude.ai/install.sh \
      | CLAUDE_INSTALL_VERSION="${CLAUDE_VERSION}" CLAUDE_INSTALL_DIR=/usr/local/share/claude bash -s -- --no-interactive; \
    ln -sf /usr/local/share/claude/bin/claude /usr/local/bin/claude; \
    claude --version

# --- non-root user ---------------------------------------------------------
# All runtime work happens as `gastown` (uid 1000). Matches typical host uid
# so bind-mounted volumes don't end up root-owned.
RUN groupadd -g 1000 gastown \
    && useradd -m -u 1000 -g gastown -s /bin/bash gastown \
    && mkdir -p /gastown /home/gastown/.claude /home/gastown/.config \
    && chown -R gastown:gastown /gastown /home/gastown

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

ENTRYPOINT ["/gastown/entrypoint.sh"]
CMD ["wizard"]

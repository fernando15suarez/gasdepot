# Docker access from inside the container

Docker access is **opt-in** via the `docker-compose.docker-host.yml` overlay. When enabled, the `gastown` container ships with a docker CLI and a bind mount of the host's `/var/run/docker.sock`. This lets Mayor (and anything else running inside the container) drive the host docker daemon directly: build images, start containers, run `docker compose`. The intended use case is letting Mayor spin up a dev container for PR testing — or letting downstream projects you scaffold inside the container drive their own docker stacks — without paste-and-run from the operator.

The default install (plain `docker compose up`) does **not** include this overlay: no docker CLI, no socket bind, no `docker` group inside the container. You have to deliberately turn it on.

## What this grants

Anything inside the container that can write to `/var/run/docker.sock` can:

- Start a container with `--privileged` and `-v /:/host`, then chroot into the host root filesystem.
- Read every file the host root user can read (host secrets, ssh keys, other users' data).
- Write every file the host root user can write.
- Stop or destroy any other container on the host, including itself.

In short: **socket access is effectively root-on-host equivalent.**

## Why it's an acceptable trust boundary here

The starter kit is single-operator: one human runs the host, one container runs Mayor on that host. The container already holds:

- The operator's `~/.claude` credentials (Claude API access).
- The operator's GitHub PAT (sufficient to push branches, open PRs, and — depending on scopes — exfiltrate private repo contents).
- Whatever lives in `.env` (API keys for Anthropic, Telegram, etc.).

Adding docker socket access doesn't materially expand the blast radius beyond what the operator has already trusted the container with. The mitigating controls are external:

- **Branch protection on `main`** — Mayor cannot bypass review; merges go through the Refinery merge queue.
- **PR-only flow** — destructive changes have to land via PR. A rogue agent run is recoverable by reverting commits.
- **Single-operator scope** — there are no other tenants on the host whose isolation we're trying to preserve.

If you intend to host this for multiple users, multi-tenant agents, or untrusted third parties, **revoke socket access** before doing so (see below).

## How to enable

The overlay model means you opt in by adding `docker-compose.docker-host.yml` to your compose stack. Two ways:

```bash
# One-off (per command):
docker compose -f docker-compose.yml -f docker-compose.docker-host.yml \
  build --build-arg DOCKER_GID=$(stat -c '%g' /var/run/docker.sock)
docker compose -f docker-compose.yml -f docker-compose.docker-host.yml up -d

# Persisted via .env so plain `docker compose up` works:
echo 'COMPOSE_FILE=docker-compose.yml:docker-compose.docker-host.yml' >> .env
docker compose build --build-arg DOCKER_GID=$(stat -c '%g' /var/run/docker.sock)
docker compose up -d
```

`gt-wizard init` also walks you through the choice and writes `COMPOSE_FILE` for you.

## How it's wired

- `docker-compose.docker-host.yml` is the opt-in overlay. It sets `INSTALL_DOCKER=1` as a build arg and bind-mounts `/var/run/docker.sock` from the host into the container at the same path.
- When `INSTALL_DOCKER=1`, the `Dockerfile` apt-installs `docker-ce-cli` and `docker-compose-plugin` from the official Docker apt repo, creates a `docker` group with a stable build-time GID (`DOCKER_GID`, default `988`), and adds the `gastown` user to it. When `INSTALL_DOCKER=0` (the default), none of those steps run — the image stays clean of docker tooling.
- `entrypoint.sh` calls `check_docker_access` at boot. It logs a confirmation when the daemon is reachable, a quiet "skipping" line when the socket isn't mounted (you didn't enable the overlay), or a warning with rebuild instructions when the in-container `docker` group GID doesn't match the host socket's GID.

### GID mismatch

The host's docker group GID is whatever the host's package manager assigned (`988` on most current Debian/Ubuntu, but it can be `999` or anything else). If your host differs from the build-time default, the entrypoint warning will print the exact rebuild command:

```bash
docker compose build --build-arg DOCKER_GID=$(stat -c '%g' /var/run/docker.sock)
docker compose up -d
```

This rebuilds with the correct GID baked in. Subsequent `docker compose` commands inside the container then work without `sudo`.

## Verification

After `docker compose up -d --build`, exec into the container and confirm:

```bash
docker compose exec gastown bash -lc 'docker compose ps'
# Should list the `gastown` container itself, no permission errors.

docker compose exec gastown bash -lc 'docker compose -f docker-compose.dev.yml up -d --build'
# Should build the dev image and start gastown-dev on the host.
```

For dev:

```bash
docker compose -f docker-compose.dev.yml exec gastown-dev bash -lc 'docker compose ps'
```

## How to disable

This is the default state — you only need to act if you previously opted in.

1. Drop the overlay from your compose stack. If you set `COMPOSE_FILE=...` in `.env`, edit it to remove `docker-compose.docker-host.yml` (or unset `COMPOSE_FILE` entirely to fall back to the lightweight default).
2. Rebuild without the overlay so the docker CLI is no longer baked in:

   ```bash
   docker compose build
   docker compose up -d --force-recreate
   ```

`INSTALL_DOCKER=0` (the new default) tells the Dockerfile to skip the docker CLI install and the in-container `docker` group, so the resulting image has no docker tooling at all. Mayor falls back to handing the operator paste-able docker commands instead of running them itself.

## Polecat inheritance

Polecats spawned by Mayor run inside the same container as Mayor and inherit the same socket access. A misbehaving polecat could in principle issue `docker` commands. The mitigation is the same as for Mayor: PRs only, branch protection, single-operator scope. If you want polecats sandboxed from the host daemon, the cleanest path is to scope the socket bind mount to a specific subset of services rather than relax it per-polecat — and that's a non-trivial refactor not in scope here.

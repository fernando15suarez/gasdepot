# Docker access from inside the container

The `gastown` container ships with a docker CLI and a bind mount of the host's `/var/run/docker.sock`. This lets Mayor (and anything else running inside the container) drive the host docker daemon directly: build images, start containers, run `docker compose`. The intended use case is letting Mayor spin up a dev container for PR testing without paste-and-run from the operator.

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

## How it's wired

- `Dockerfile` installs `docker-ce-cli` and `docker-compose-plugin` from the official Docker apt repo, creates a `docker` group with a stable build-time GID (`DOCKER_GID`, default `988`), and adds the `gastown` user to it.
- `docker-compose.yml` and `docker-compose.dev.yml` bind-mount `/var/run/docker.sock` from the host into the container at the same path.
- `entrypoint.sh` calls `check_docker_access` at boot. It logs a confirmation when the daemon is reachable, or a warning with rebuild instructions when the in-container `docker` group GID doesn't match the host socket's GID.

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

If you don't want the container talking to the host daemon, remove the socket bind mount from both compose files:

```yaml
# Delete this block from docker-compose.yml AND docker-compose.dev.yml:
- type: bind
  source: /var/run/docker.sock
  target: /var/run/docker.sock
```

Then `docker compose up -d --force-recreate`. Mayor falls back to handing the operator paste-able docker commands instead of running them itself. The CLI binary stays in the image (harmless without a socket to talk to), or you can also drop the `docker-ce-cli` install from the Dockerfile if image size matters.

## Polecat inheritance

Polecats spawned by Mayor run inside the same container as Mayor and inherit the same socket access. A misbehaving polecat could in principle issue `docker` commands. The mitigation is the same as for Mayor: PRs only, branch protection, single-operator scope. If you want polecats sandboxed from the host daemon, the cleanest path is to scope the socket bind mount to a specific subset of services rather than relax it per-polecat — and that's a non-trivial refactor not in scope here.

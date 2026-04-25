# Docker access from inside the container

The `gastown` container ships with the docker CLI in the image but **does not** bind the host docker socket by default. Activating the `docker-compose.docker-host.yml` overlay binds `/var/run/docker.sock` from the host so Mayor (and anything else running inside the container) can drive the host docker daemon directly: build images, start containers, run `docker compose`. The intended use case is letting Mayor — or polecats spawned by Mayor — spin up downstream container projects from inside Gas Town without paste-and-run from the operator.

The default install deliberately omits this bind so a fresh clone gives you the tightest trust posture. Read the rest of this page before opting in.

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

- `Dockerfile` installs `docker-ce-cli` and `docker-compose-plugin` from the official Docker apt repo, creates a `docker` group with a stable build-time GID (`DOCKER_GID`, default `988`), and adds the `gastown` user to it. These layers run unconditionally — the CLI is harmless without a socket to talk to, and keeping the user-group setup uniform avoids per-image divergence.
- `docker-compose.docker-host.yml` is the **opt-in overlay** that bind-mounts `/var/run/docker.sock` from the host into the container at the same path and pipes `DOCKER_GID` from `.env` into the build. The default `docker-compose.yml` and `docker-compose.dev.yml` do NOT mount the socket.
- `entrypoint.sh` calls `check_docker_access` at boot. With the overlay applied, it logs a confirmation when the daemon is reachable, or a warning with rebuild instructions when the in-container `docker` group GID doesn't match the host socket's GID. Without the overlay, it logs `docker socket not mounted — skipping daemon access check.` and moves on.

### GID mismatch

The host's docker group GID is whatever the host's package manager assigned (`988` on most current Debian/Ubuntu, but it can be `999` or anything else). If your host differs from the build-time default, the entrypoint warning will print the exact rebuild command. The cleanest fix is to capture the GID once in `.env` so all future builds use it:

```bash
echo "DOCKER_GID=$(stat -c '%g' /var/run/docker.sock)" >> .env
docker compose up -d --build
```

The overlay reads `DOCKER_GID` from `.env` (falling back to `988`) and passes it as a build arg. Subsequent `docker compose` commands inside the container then work without `sudo`.

## How to enable

Pick one of:

**One-shot:** layer the overlay onto the default compose file.

```bash
docker compose -f docker-compose.yml -f docker-compose.docker-host.yml up -d --build
```

**Persist:** capture the chosen overlays in `.env` so plain `docker compose` invocations honor them. The wizard does this for you when you answer yes to the "docker access" prompt during `gt-wizard init`.

```bash
echo 'COMPOSE_FILE=docker-compose.yml:docker-compose.docker-host.yml' >> .env
docker compose up -d --build
```

## Verification

After bringing the stack up with the overlay, exec into the container and confirm:

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

The default install never enables this in the first place. If you previously opted in and want to drop back to the lightweight default:

1. Remove the docker-host overlay from `COMPOSE_FILE` in `.env`. Either delete the line, blank it out, or rewrite it to just `docker-compose.yml` (plus any other overlays you keep).
2. `docker compose down && docker compose up -d --force-recreate`

Mayor will fall back to handing the operator paste-able docker commands instead of running them itself. The CLI binary stays in the image — it's harmless without a socket to talk to, and keeping it avoids a rebuild if you later opt back in.

## Polecat inheritance

Polecats spawned by Mayor run inside the same container as Mayor and inherit the same socket access. A misbehaving polecat could in principle issue `docker` commands. The mitigation is the same as for Mayor: PRs only, branch protection, single-operator scope. If you want polecats sandboxed from the host daemon, the cleanest path is to scope the socket bind mount to a specific subset of services rather than relax it per-polecat — and that's a non-trivial refactor not in scope here.

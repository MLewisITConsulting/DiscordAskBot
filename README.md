# AskBot

A long-running service that answers questions in Discord with the omp agent (`@oh-my-pi/pi-coding-agent`). Anyone in an ask-only channel starts a thread with `/ask`; the agent answers with web search, the files attached in the thread, and the skills and task agents the admin installed, and can produce text files. A password-protected web UI handles configuration and operations. The design lives in [`wiki/`](wiki/): [requirements](wiki/requirements.md), [architecture](wiki/architecture.md) and the [implementation plan](wiki/implementation.md).

## Installation

AskBot ships as one image, `ghcr.io/mlewisitconsulting/askbot:<version>` / `:latest`; the role is the command argument (`orchestrator`, `web`, `worker`, `launcher`; OPS-01). There are two supported installation paths: rootless Podman and Kubernetes. Docker Engine cannot run the full stack.

| | Podman (rootless) | Kubernetes | Docker Engine |
|---|---|---|---|
| Status | Supported | Supported | Not supported for the full stack |
| Minimum versions | rootless Podman ≥ 4.6, plus docker-compose or podman-compose as the `podman compose` provider | Kubernetes ≥ 1.27, KEDA ≥ 2.12 (≥ 2.19 recommended), Helm 3 | none |
| Starts workers | the `launcher` service, through your rootless Podman socket, up to `ASKBOT_WORKER_CAPACITY` (default 4) | a KEDA `ScaledJob`, up to `worker.maxReplicas` (default 10) | none: the launcher refuses the Docker socket |
| Storage | one named volume, `askbot-state` | one ReadWriteOnce PVC (`state`, 10Gi); no ReadWriteMany | none |
| Secrets | `scripts/init-secrets.sh`: files in `secrets/` and the Podman secret `askbot_worker_token` | the chart generates Secret `askbot`, or use `secrets.existingSecret` | none |
| Steps | [Running on Podman](#running-on-podman) | [Running on Kubernetes](#running-on-kubernetes) | [Docker Engine](#docker-engine-not-supported) |

CI only tests, publishes `ghcr.io/mlewisitconsulting/askbot:<version>` and `:latest`, and tags `v<version>`; deployments of a particular installation are not run from this repository.

## Running on Podman

`compose.yaml` runs three long-running services from one image: `orchestrator`, `web` and `launcher`. The launcher starts one short-lived worker container per agent run through your rootless Podman socket, and removes it when the run ends (architecture §7.2).

**Requirements:** rootless Podman ≥ 4.6 and a compose provider for `podman compose`: docker-compose or podman-compose. A rootful Podman socket is refused too (LCH-01); [Docker Engine](#docker-engine-not-supported) explains the scope of `ASKBOT_LAUNCHER_ALLOW_ROOTFUL`.

1. **Enable your user's Podman socket** once, as the user that will run the stack:

   ```sh
   systemctl --user enable --now podman.socket
   loginctl enable-linger "$USER"   # keep it, and the stack, running after you log out
   ```

2. **Get the image.** Released images are `ghcr.io/mlewisitconsulting/askbot:<version>` and `:latest` (the default):

   ```sh
   podman compose pull
   ```

   Or build it from this repository and point compose at it:

   ```sh
   podman build -t localhost/askbot:dev .
   export ASKBOT_IMAGE=localhost/askbot:dev   # or put ASKBOT_IMAGE=... into .env next to compose.yaml
   ```

3. **Create the secrets** once:

   ```sh
   scripts/init-secrets.sh
   ```

   It writes the master key and the web, worker and scale tokens as random files (mode 0400) into `secrets/` next to `compose.yaml` (`ASKBOT_SECRETS_DIR` moves it), and stores the worker token a second time as the Podman secret `askbot_worker_token`, which the launcher hands to workers. Running it again keeps everything. Back up `secrets/` with the volume: without the master key the settings stay locked until an admin logs in (SEC-05).

4. **Start the stack:**

   ```sh
   podman compose up -d
   podman compose ps   # orchestrator, web and launcher report (healthy) after about 40 s
   ```

5. **Open <http://127.0.0.1:8080>** (only web publishes a port, on loopback; put a TLS reverse proxy in front for remote access). On first start the page asks for the setup token, which the orchestrator prints once:

   ```sh
   podman compose logs orchestrator | grep setupToken
   ```

   Create the admin account there, then follow the getting-started checklist on the home page ([Configuration](#configuration)).

**Upgrade:** `podman compose pull && podman compose up -d`. Runs in progress keep their worker and finish; new workers use the new image. Stop the stack with `podman compose stop`, not `down`: `down` removes the network running workers are attached to.

**Settings in the environment** (shell or `.env` next to `compose.yaml`; the header of `compose.yaml` lists them all): `ASKBOT_WORKER_CAPACITY` (most concurrent workers, default 4), `ASKBOT_WORKER_MEMORY` (limit per worker, no swap, default `4g`), `ASKBOT_WORKER_CPUS` (CPU quota per worker, default 2), `ASKBOT_WORKER_DISK` (scratch space per worker, default `2g`; a soft limit the worker measures, STO-06), `ASKBOT_WEB_HOST_PORT` (default 8080), `ASKBOT_NETWORK` (default `askbot`; workers get their own network, `<ASKBOT_NETWORK>-workers`, where they reach only the orchestrator), `ASKBOT_WEB_TRUSTED_PROXIES` (your reverse proxy's address as web sees it, so failed logins count against the client and not the proxy), `ASKBOT_WORKER_ADDRESS_BINDING` (default `on`; see architecture §6).

**Rotating the web token.** The web token opens the whole admin API and never expires. Replace it when it may have leaked; the orchestrator and web read it only at start, and runs in progress are not affected (RUN-09):

```sh
rm -f secrets/askbot_web_api_token        # or under $ASKBOT_SECRETS_DIR
scripts/init-secrets.sh                    # creates a new one, keeps the others
podman compose up -d --force-recreate orchestrator web
```

### Memory budget

Plan for **4 GiB minimum, 8 GiB recommended** (NFR-01). Measured: orchestrator about 270 MB, web about 35 MB, launcher about 20 MB (`podman stats`), and about 600 MB per concurrent run (worker supervisor about 190 MB plus the agent host about 420 MB with a real model). Each worker is capped by `ASKBOT_WORKER_MEMORY`. On a small host lower `ASKBOT_WORKER_CAPACITY`, and `maxChatSessions` in Settings.

### On macOS (podman machine)

The stack runs in the machine's VM; use its rootless connection (`export CONTAINER_CONNECTION=podman-machine-default` when the machine is rootful). Two things differ from a Linux host:

- `podman compose` with docker-compose talks to the machine's API socket, which is the **rootful** engine on a rootful machine. Point `DOCKER_HOST` at the rootless socket instead (forward `/run/user/<uid>/podman/podman.sock` from the VM over ssh), or use podman-compose, which follows `CONTAINER_CONNECTION`.
- `XDG_RUNTIME_DIR` is the Mac's, not the VM's: set `ASKBOT_HOST_PODMAN_SOCKET=/run/user/<uid>/podman/podman.sock` (the VM path; `podman info --format '{{.Host.RemoteSocket.Path}}'` prints it).

`test/e2e/compose/smoke.sh` does both; see [its README](test/e2e/compose/README.md).

## Running on Kubernetes

The Helm chart `deploy/helm/askbot` runs the orchestrator and web as single-replica Deployments and the workers as a KEDA `ScaledJob`: one Job pod per pending run, from 0 up to `worker.maxReplicas` (default 10), each deleted a minute after its run (architecture §7.3).

**Requirements:** Kubernetes ≥ 1.27 and KEDA ≥ 2.12 (≥ 2.19 recommended: older versions can start one extra worker pod near `worker.maxReplicas`). The chart refuses to install on an older cluster or without KEDA's `ScaledJob` API. One ReadWriteOnce PVC; no ReadWriteMany.

```sh
helm install askbot deploy/helm/askbot -n askbot --create-namespace --set image.tag=<version>
kubectl -n askbot logs deploy/askbot-orchestrator | grep setupToken
kubectl -n askbot port-forward svc/askbot-web 8080:8080   # or enable web.ingress (below)
```

The commands assume release name `askbot`. With another name the objects are `<release>-askbot-*`; `helm install` prints the matching commands.

- **Secrets:** the master key and the web, worker and scale tokens are generated on first install into Secret `askbot` and kept on every upgrade. `secrets.existingSecret` names your own Secret instead (keys `master-key` of at least 32 characters, `web-api-token`, `worker-token`, `scale-token`). The Secret and the state PVC are kept on `helm uninstall`; back them up together. To rotate the web token, put a new value into the Secret and restart both readers (upgrades keep the new value):

  ```sh
  kubectl -n askbot patch secret askbot --type merge -p "{\"data\":{\"web-api-token\":\"$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' | base64 | tr -d '\n')\"}}"
  kubectl -n askbot rollout restart deploy/askbot-orchestrator deploy/askbot-web
  ```
- **Behind the ingress:** set `web.ingress.enabled=true` and `web.ingress.host` (`web.ingress.className` selects the controller; `web.ingress.tls.secretName`, empty means the controller's default certificate). Set `web.trustedProxies` to the ingress controller pods' addresses (e.g. the pod CIDR), so the login throttle counts each client, not the controller.
- **Concurrency:** `worker.maxReplicas` is also the orchestrator's worker capacity. To use all of it, raise `maxChatSessions` in Settings; the orchestrator's health warns while it is lower.
- **Workers:** `worker.diskLimit` (scratch space, default 2Gi) and `worker.resources` (default requests 250m CPU / 512 Mi memory / 2 Gi ephemeral storage, limit 4 Gi memory; when you change `worker.diskLimit`, change the ephemeral-storage request to match).
- **NetworkPolicies** (on by default): the orchestrator accepts only web, workers and the KEDA operator (`networkPolicy.keda` selects it), web only the ingress controller (`networkPolicy.web.ingressController`, or `networkPolicy.web.allowAll=true`), workers nothing. Web may connect only to DNS and the orchestrator. Workers may connect to DNS, the orchestrator and the internet, but not to link-local addresses (cloud metadata) or `networkPolicy.worker.clusterCIDRs` (default: every private range). Set `networkPolicy.dns` if your cluster's DNS is not kube-dns in `kube-system`, and add NodeLocal DNSCache's address there if you use it.

**Upgrade:** `helm upgrade askbot deploy/helm/askbot -n askbot --reuse-values --set image.tag=<version>`. The orchestrator restarts once (`Recreate`); runs in progress keep their worker pod, re-attach and finish.

`values.yaml` documents every value. `test/e2e/k8s/install-smoke.sh` installs the chart on a local kind cluster (`test/e2e/k8s/kind.sh up`, kind on Podman with KEDA) and runs a worker through it.

## Docker Engine (not supported)

Docker Engine cannot run the full stack (OPS-03). The launcher starts workers only through a Podman API socket: it calls `GET /libpod/info`, a Docker socket has no `/libpod/` routes, and the launcher exits with "the socket is not a Podman API socket" (LCH-01). No worker ever starts, so runs stay pending ("Waiting for a worker…"). `compose.yaml` and `scripts/init-secrets.sh` also target rootless Podman: `keep-id` user namespaces, the Podman socket mount, the Podman secret and the script's rootless check.

`ASKBOT_LAUNCHER_ALLOW_ROOTFUL=1` is **not** a Docker workaround. It never accepts a Docker socket. It only lets the launcher use a rootful *Podman* socket, which gives the launcher root on the host and logs a warning at every start (LCH-01). `compose.yaml` does not set it.

**Building the image with Docker works.** CI builds the released image this way, from the root `Dockerfile`:

```sh
docker build -t <registry>/askbot:<tag> .
docker push <registry>/askbot:<tag>
```

Then set `ASKBOT_IMAGE` (Podman) or `image.repository` and `image.tag` (Helm).

## Configuration

Everything an admin enters lives in the orchestrator's encrypted settings vault and is edited in the web UI; there are no configuration files ([requirements §9](wiki/requirements.md) lists every setting):

1. **Settings** (`/admin`): the Discord bot token and guild, allowed users and roles, the agent name, the `/ask` model, limits and logs. Once the bot token and guild are saved, ask-only channels are chosen from a dropdown that shows the bot's missing permissions; the engine starts when at least one is chosen. The bot needs the Guilds, GuildMessages and MessageContent intents (enable Message Content in the Developer Portal) and, for its server nickname, Change Nickname.
2. **Model accounts** (`/admin/models`): sign in to model providers, or add provider API keys under Settings.
3. **omp** (`/admin/omp`): omp setting overrides, the omp version and in-place updates (Check now, Approve update, or automatic with Settings → omp → Install omp updates automatically). A few settings are pinned (AGT-20).
4. **Skills and agents** (`/admin/skills`): upload skills (`SKILL.md` or a `.zip` of the folder) and task agents (one `.md` file). An agent's frontmatter must name `tools`, and only `web_search` is allowed; `/ask` reads skills with `read_file skill://<name>` and runs agents with `task` (AGT-24 to AGT-32).

Allowed members (`allowedUserIds`, `allowedRoleIds`) may follow up, steer and `/stop` in every ask thread and are exempt from the one-live-run limit; everyone else can do so only in the threads they started.

## Security notes

Read [architecture §6](wiki/architecture.md) and the [security review](wiki/security-review.md) before opening an ask channel to the public. In short:

- **Anyone in an ask channel steers the agent.** The agent has no shell and no unconfined file access: its file tools are confined to the thread's scratch directory and the read-only skills, and task agents may use only `web_search`. Within its own run the agent can still reach the run's provider keys and model sign-in copies only through a bug in those tools; spending is bounded by `limits.maxCostUsdPerTurn`, one live run per public user and `limits.maxChatSessions`.
- **Workers can't claim other runs from their own address.** Claims are tied to the worker's network address (`ASKBOT_WORKER_ADDRESS_BINDING`, on by default; leave it on unless a service mesh rewrites source addresses).
- **On Podman, workers can reach the web UI's published port through the host.** They can't sign in without the password, but repeated failed logins count against the same address as a browser on the host. Put a TLS reverse proxy in front for remote access and set `ASKBOT_WEB_TRUSTED_PROXIES`.

## Dry run

`bun run dry-run` runs the `ask` profile locally, without Discord (OPS-06): a temporary scratch directory with the given files in `inputs/`, the same prompt, tools and limits as a worker, then the answer (JSON), the files produced in `outputs/`, and the usage. The temporary directory is removed afterwards, also on Ctrl-C.

```sh
bun run dry-run --prompt "Summarise the attached report" --file report.pdf [--omp-dir ./my-omp] [--model anthropic/claude-haiku-4-5] [--thinking low]
```

`--omp-dir` supplies skills (`skills/<name>/SKILL.md`) and agents (`agents/<name>.md`); the run uses a copy. Model sign-ins come from your own omp (`--agent-dir`, else `PI_CODING_AGENT_DIR`, else `~/.omp/agent`; sign in with `omp` first), and provider API keys such as `ANTHROPIC_API_KEY` from the environment.

## Development

```sh
bun install
bun run typecheck
bun test                                    # unit and integration tests
ASKBOT_REAL_MODEL=1 bun test test/integration/realmodel.test.ts   # skills and task agents against a real model
```

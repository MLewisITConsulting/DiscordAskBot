# Compose stack end-to-end check

`smoke.sh` runs the repository's `compose.yaml` on real rootless Podman and drives one real `/ask` run on a launcher-started worker container without Discord or model credentials (architecture §7.2, LCH-01 to LCH-04, OPS-03, NFR-01).

```sh
test/e2e/compose/smoke.sh            # BUILD=0 reuses localhost/askbot:dev and localhost/askbot-e2e:dev; KEEP=1 leaves the stack running
PODMAN_COMPOSE_PROVIDER=podman-compose test/e2e/compose/smoke.sh   # the same with podman-compose instead of docker-compose
```

The stack is `compose.yaml` plus `compose.e2e.yaml`: the e2e scenario image (`test/e2e/k8s/Containerfile`, the release image plus the test fakes) runs the orchestrator — the real internals with the fake Discord (`test/e2e/k8s/orchestrator.ts`) — and, as the launcher's `ASKBOT_IMAGE`, the workers, which run a real worker with the fixture agent host. Web and the launcher are the release image. The scenario orchestrator's control API (`/internal/admin/e2e/`, web token) is published on `127.0.0.1:18081` (`ORCH_PORT`). The chaos tests (`test/e2e/chaos/run.ts`) use the same override.

Defaults fit a macOS podman machine whose default connection is rootful: the stack uses the rootless connection `podman-machine-default` (`ROOTLESS_CONNECTION`), the rootful check uses `podman --connection podman-machine-default-root` (`ROOTFUL_PODMAN`). On a Linux host run it as the stack user with `ROOTLESS_CONNECTION= ROOTFUL_PODMAN="sudo podman"`.

It uses its own compose project, networks (`askbot-e2e-compose` and the workers network `askbot-e2e-compose-workers`), ports (`127.0.0.1:18080` web, `WEB_PORT`), secrets directory (a temporary one) and worker-token secret name (`askbot_e2e_compose_worker_token`), so it does not touch a real stack on the same engine. It removes leftovers of an earlier run first, and everything it created at the end (`podman compose down -v`, the Podman secret, the secrets directory), unless `KEEP=1`.

Steps and checks:

1. Builds `localhost/askbot:dev` and `localhost/askbot-e2e:dev` on the rootless engine, runs `scripts/init-secrets.sh` twice (the second run keeps everything) and `podman compose up -d`. Waits until all three services report `healthy`.
2. Worker network (security review F6): prints the workers network's options (podman-compose passes `isolate=strict`, Podman's Docker API drops it, Podman ≥ 6 isolates by default), then runs the image as uid 10001 on it, where workers run, and fetches `orchestrator:8081/healthz` (must be 200), `web:8080/healthz` and web's address on the stack network (both must fail). It also prints, for information, whether web's published host port answers through `host.containers.internal`, `169.254.1.2` and the network's gateway: Podman forwards published ports from there, which is the known residual of F6.
3. Creates the admin through `/setup` with the setup token from `podman compose logs orchestrator`. The scenario orchestrator then seeds its settings (one ask channel, one allowed user) and the engine starts. Prints `podman stats` of the idle services (NFR-01).
4. `/ask` in the fake ask channel with `fixture:slow fixture-hold-seconds:6` (`HOLD_SECONDS`), so the worker is visible. The launcher starts a worker container for the run. Checks that exactly one worker container (`label=askbot.role=worker` on the workers network, and on no other network) appears, prints `podman ps` and `podman stats` while it runs, and checks that exactly one `answer.md` with the fixture's answer and "Done" reach the thread, that the run finished on that worker and that no worker container is left. Prints the worker's create/start/died/remove events and the orchestrator's and launcher's log lines for the run.
5. Runs the release image as the launcher service against the rootful socket (`--user 0 --security-opt label=disable`, `/run/podman/podman.sock`): it must exit 2 with "the Podman socket is rootful (LCH-01)".
6. Prints the timings: `up -d` to all healthy, worker create to remove, and `/ask` to answer.

## How it reaches the rootless engine

`podman compose` hands docker-compose the machine's API socket, which is the rootful engine on a rootful podman machine, whatever `CONTAINER_CONNECTION` says. The script therefore forwards the rootless socket from the VM (`podman info --format '{{.Host.RemoteSocket.Path}}'`) over the connection's ssh to a local socket and exports `DOCKER_HOST`, which `podman compose` keeps. podman-compose runs the `podman` CLI and follows `CONTAINER_CONNECTION`, which the script also exports. On macOS `XDG_RUNTIME_DIR` is the Mac's, so the script passes the VM path of the socket as `ASKBOT_HOST_PODMAN_SOCKET`. `rootless-socket.sh` holds the forwarding, shared with the chaos tests.

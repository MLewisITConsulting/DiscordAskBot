#!/usr/bin/env bash
# Compose stack smoke test on real rootless Podman (architecture §7.2, requirements OPS-03, LCH-01 to LCH-04; README.md
# next to this file).
#   test/e2e/compose/smoke.sh
# 1. Builds the release image and the e2e scenario image on the rootless engine (BUILD=0 reuses them), creates the
#    secrets with scripts/init-secrets.sh (twice, to show it keeps them) and starts compose.yaml plus compose.e2e.yaml
#    with `podman compose up -d` under its own project, network, ports, secrets directory and worker-token secret name.
#    The override runs the e2e image as the orchestrator (real internals, fake Discord) and, through the launcher's
#    ASKBOT_IMAGE, as the workers (a real worker with the fixture agent host); web and the launcher are the release
#    image's. Waits until orchestrator, web and launcher are healthy.
# 2. Worker network (security review F6): a container on the workers network, as a worker is, reaches the orchestrator
#    but not web, neither by name nor by web's address on the stack network.
# 3. Creates the admin through /setup with the setup token from `podman compose logs orchestrator`; the scenario
#    orchestrator then seeds its settings (one ask channel, one allowed user) and the engine starts.
# 4. `/ask` in the fake ask channel (the e2e control API on the orchestrator's published port). The launcher starts a
#    worker container for the run: exactly one must appear, on the workers network only; the answer (`answer.md`) and
#    "Done" must reach the thread, and no worker may remain afterwards. Prints `podman stats` while the worker runs.
# 5. Runs the release image as the launcher service against the rootful socket: it must refuse with exit 2 (LCH-01).
# 6. Tears everything down (KEEP=1 leaves the stack running and prints how to remove it).
# Env: ROOTLESS_CONNECTION (default podman-machine-default; empty = the local podman), ROOTFUL_PODMAN (default
# `podman --connection podman-machine-default-root`; e.g. `sudo podman` on a Linux host), ROOTFUL_SOCKET, IMAGE
# (default localhost/askbot:dev), E2E_IMAGE (default localhost/askbot-e2e:dev), BUILD (default 1), WEB_PORT (default
# 18080), ORCH_PORT (default 18081), HOLD_SECONDS (default 6: how long the fixture holds the run, so the worker is
# visible), KEEP.
set -euo pipefail

root="$(cd "$(dirname "$0")/../../.." && pwd)"
rootless_conn="${ROOTLESS_CONNECTION-podman-machine-default}"
rootful_sock="${ROOTFUL_SOCKET:-/run/podman/podman.sock}"
image="${IMAGE:-localhost/askbot:dev}"
e2e_image="${E2E_IMAGE:-localhost/askbot-e2e:dev}"
port="${WEB_PORT:-18080}"
orch_port="${ORCH_PORT:-18081}"
hold="${HOLD_SECONDS:-6}"
project=askbot-e2e-compose
net=askbot-e2e-compose
# compose.yaml names the workers network after the stack network.
workers_net="$net-workers"
worker_secret=askbot_e2e_compose_worker_token
base="http://127.0.0.1:$port"
orch="http://127.0.0.1:$orch_port/internal/admin/e2e"
P="podman${rootless_conn:+ --connection $rootless_conn}"
R="${ROOTFUL_PODMAN:-podman --connection podman-machine-default-root}"
work="$(mktemp -d)"
# shellcheck source=rootless-socket.sh
. "$root/test/e2e/compose/rootless-socket.sh"

now_ms() { bun -e 'process.stdout.write(String(Date.now()))'; }
secs() { awk -v ms="$1" 'BEGIN { printf "%.1f s", ms / 1000 }'; }

# The compose provider talks to DOCKER_HOST. `podman compose` points it at the machine's API socket, which is the
# rootful engine on a rootful podman machine, so the rootless socket is forwarded over the connection's ssh instead.
forward_rootless_socket "$rootless_conn" "$work"

export ASKBOT_IMAGE="$e2e_image" ASKBOT_BASE_IMAGE="$image" ASKBOT_NETWORK="$net" ASKBOT_WORKER_SECRET="$worker_secret"
export ASKBOT_WEB_HOST_PORT="$port" E2E_ORCH_PORT="$orch_port"
export ASKBOT_HOST_PODMAN_SOCKET="$host_sock" ASKBOT_SECRETS_DIR="$work/secrets" ASKBOT_WORKER_CAPACITY=2
# PODMAN_COMPOSE_WARNING_LOGS=false drops podman's "Executing external compose provider" banner.
export PODMAN_COMPOSE_WARNING_LOGS=false
C="podman compose -f $root/compose.yaml -f $root/test/e2e/compose/compose.e2e.yaml -p $project"
compose() { $C "$@" 2>&1; }

teardown() {
	compose down -v --remove-orphans >/dev/null || true
	$P secret rm "$worker_secret" >/dev/null 2>&1 || true
}

cleanup() {
	if [ "${KEEP:-}" = 1 ]; then
		echo "== KEEP=1: the stack keeps running on $base (admin / ${password:-not created}). Remove it with:"
		echo "   DOCKER_HOST=$DOCKER_HOST $C down -v; $P secret rm $worker_secret"
		echo "   (the ssh forward $forward_pid and $work stay for that)"
		return
	fi
	teardown
	[ -n "$forward_pid" ] && kill "$forward_pid" 2>/dev/null || true
	rm -rf "$work"
}
trap cleanup EXIT

fail() {
	echo "FAIL: $*" >&2
	for s in orchestrator web launcher; do
		echo "== $s log" >&2
		compose logs --no-color --tail 30 "$s" >&2 || true
	done
	exit 1
}

# Containers of one compose service (works with docker-compose and podman-compose labels).
cid() { $P ps -aq --filter "label=com.docker.compose.project=$project" --filter "label=com.docker.compose.service=$1"; }
workers() { $P ps -a --filter label=askbot.role=worker --filter "network=$workers_net" --format "$1"; }
# The scenario orchestrator's control API (test/e2e/k8s/orchestrator.ts), with the web token.
ctl() { curl -s --max-time 10 -H "authorization: Bearer $web_token" -H 'content-type: application/json' "$@"; }
# `$1` of a JSON document on stdin (a JS expression over `d`).
json() { bun -e "const d = await Bun.stdin.json(); const v = $1; process.stdout.write(typeof v === 'string' ? v : JSON.stringify(v))"; }

echo "== clean state (project $project, networks $net and $workers_net, secret $worker_secret)"
teardown
[ -z "$($P ps -aq --filter "label=com.docker.compose.project=$project")" ] || fail "containers of $project left over"
[ -z "$(workers '{{.Names}}')" ] || fail "worker containers on $workers_net left over"

if [ "${BUILD:-1}" = 1 ]; then
	echo "== build $image and $e2e_image (rootless)"
	start=$(now_ms)
	$P build -q -t "$image" "$root" >/dev/null
	$P build -q -f "$root/test/e2e/k8s/Containerfile" --ignorefile "$root/test/e2e/k8s/Containerfile.containerignore" \
		--build-arg "BASE_IMAGE=$image" -t "$e2e_image" "$root" >/dev/null
	echo "built in $(secs $(($(now_ms) - start)))"
fi

echo "== scripts/init-secrets.sh (twice: the second run keeps everything)"
"$root/scripts/init-secrets.sh" | sed "s|$work|\$work|; s/^/  /"
"$root/scripts/init-secrets.sh" | sed "s|$work|\$work|; s/^/  /"
web_token=$(cat "$work/secrets/askbot_web_api_token")

echo "== podman compose up -d"
start=$(now_ms)
compose up -d >"$work/up.log" || { cat "$work/up.log"; fail "podman compose up -d failed"; }
sed 's/^/  /' "$work/up.log"
healthy=""
for _ in $(seq 1 120); do
	states=""
	for s in orchestrator web launcher; do
		id=$(cid "$s")
		[ -n "$id" ] || fail "no $s container"
		states="$states $($P inspect --format '{{.State.Health.Status}}' "$id")"
	done
	if [ "$states" = " healthy healthy healthy" ]; then healthy=1; break; fi
	sleep 1
done
[ -n "$healthy" ] || fail "services not healthy:$states"
up_ms=$(($(now_ms) - start))
$P ps --filter "label=com.docker.compose.project=$project" --format '{{.Names}}  {{.Image}}  {{.Status}}  {{.Ports}}' | sed 's/^/  /'
echo "all three services healthy $(secs $up_ms) after up -d"
[ "$(curl -s -o /dev/null -w '%{http_code}' "$base/healthz")" = 200 ] || fail "web /healthz on $base is not 200"

echo "== worker network $workers_net (F6): only the orchestrator is reachable"
# podman-compose passes `isolate: strict` on; Podman's Docker API drops it (docker-compose), and Podman >= 6 isolates
# bridge networks by default. Either way the probe below must show the isolation.
options=$($P network inspect "$workers_net" --format '{{.Options}}')
echo "  options $options (podman $($P version --format '{{.Server.Version}}'))"
for s in orchestrator web launcher; do
	echo "  $s: $($P inspect --format '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}={{$v.IPAddress}} {{end}}' "$(cid "$s")")"
done
web_ip=$($P inspect --format "{{(index .NetworkSettings.Networks \"$net\").IPAddress}}" "$(cid web)")
[ -n "$web_ip" ] || fail "web has no address on $net"
workers_gw=$($P network inspect "$workers_net" --format '{{range .Subnets}}{{.Gateway}}{{end}}')
probe_js='for (const url of process.argv.slice(1)) console.log(url, await fetch(url, { signal: AbortSignal.timeout(3000) }).then(r => String(r.status), e => e.name))'
# The last three are web's published host port, through the host address and the network's own gateway: Podman forwards
# a published port from there too, across isolated networks (netavark >= 2.1). Informational: the known residual of F6.
$P run --rm --network "$workers_net" --user 10001:10001 --entrypoint bun "$image" -e "$probe_js" \
	http://orchestrator:8081/healthz http://web:8080/healthz "http://$web_ip:8080/healthz" \
	"http://host.containers.internal:$port/healthz" "http://169.254.1.2:$port/healthz" "http://$workers_gw:$port/healthz" \
	>"$work/probe.log" 2>&1 || { cat "$work/probe.log"; fail "the probe container failed"; }
sed 's/^/  /' "$work/probe.log"
grep -qx 'http://orchestrator:8081/healthz 200' "$work/probe.log" || fail "a worker cannot reach the orchestrator"
grep -qE '^http://web:8080/healthz [0-9]+$' "$work/probe.log" && fail "a worker reaches web:8080 by name"
grep -qE "^http://$web_ip:8080/healthz [0-9]+$" "$work/probe.log" && fail "a worker reaches web at $web_ip:8080"
echo "a worker reaches the orchestrator, but not web:8080 by name or address (published host port: informational)"

echo "== /setup with the setup token from podman compose logs orchestrator"
token=$(compose logs --no-color orchestrator | grep -o '"setupToken":"[^"]*"' | tail -1 | cut -d'"' -f4)
[ -n "$token" ] || fail "no setup token in the orchestrator log"
password="e2e-$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"
jar="$work/cookies"
post() { curl -s -b "$jar" -c "$jar" -o "$work/body.html" -w '%{http_code} %{redirect_url}' -H "Origin: $base" "$@"; }
out=$(post --data-urlencode "token=$token" --data-urlencode username=admin --data-urlencode "password=$password" --data-urlencode "confirm=$password" "$base/setup")
[ "$out" = "303 $base/" ] || fail "setup answered $out"
echo "admin created"

phase=""
for _ in $(seq 1 60); do
	phase=$(ctl "$orch/state" | json d.phase 2>/dev/null || true)
	[ "$phase" = running ] && break
	sleep 0.5
done
[ "$phase" = running ] || fail "the engine is not running after setup (phase ${phase:-unknown})"
echo "engine running with the seeded e2e settings: $(curl -s "http://127.0.0.1:$orch_port/readyz" | json '({ phase: d.phase, limits: d.limits })')"
echo "== podman stats --no-stream (idle: engine running, no run; NFR-01)"
$P stats --no-stream --format '{{.Name}}  mem={{.MemUsage}}  cpu={{.CPUPerc}}' $(cid orchestrator) $(cid web) $(cid launcher) | sed 's/^/  /'

echo "== /ask in the fake ask channel (fixture:slow, held $hold s so that the worker is visible)"
[ -z "$(workers '{{.Names}}')" ] || fail "worker containers exist before the ask"
events_since=$(($(date +%s) - 5))
start=$(now_ms)
out=$(ctl -X POST -d "{\"prompt\":\"What does AskBot do? fixture:slow fixture-hold-seconds:$hold\"}" "$orch/ask")
thread=$(echo "$out" | json 'd.thread ?? ""')
[ -n "$thread" ] || fail "/ask was refused: $out"
echo "thread $thread: $(echo "$out" | json d.reply)"
# The thread's bot messages: done once "Done" is there.
thread_js="(d.find(t => t.id === '$thread')?.messages.filter(m => m.bot) ?? [])"
seen=""
sampled=""
done_msg=""
for _ in $(seq 1 300); do
	listed=$(workers '{{.Names}}  {{.Image}}  {{.Status}}  networks={{.Networks}}  ports=[{{.Ports}}]')
	if [ -n "$listed" ]; then
		for name in $(echo "$listed" | awk '{ print $1 }'); do
			case " $seen " in *" $name "*) ;; *)
				seen="$seen $name"
				echo "== podman ps --filter label=askbot.role=worker --filter network=$workers_net (during the run)"
				echo "$listed" | sed 's/^/  /'
				echo "$listed" | grep "^$name " >>"$work/listed"
				;;
			esac
		done
		# NFR-01: one sample while the agent host holds the run (not while the worker is still starting).
		if [ -z "$sampled" ] && [ -n "$(ctl "$orch/state" | json "d.runs.some(r => r.thread === '$thread' && r.state === 'running') ? 'yes' : ''" 2>/dev/null || true)" ]; then
			sampled=1
			sleep 1
			echo "== podman stats --no-stream (during the run, agent host holding; NFR-01)"
			$P stats --no-stream --format '{{.Name}}  mem={{.MemUsage}}  cpu={{.CPUPerc}}' \
				$(cid orchestrator) $(cid web) $(cid launcher) $(echo "$listed" | awk '{ print $1 }') 2>/dev/null | sed 's/^/  /' || true
		fi
	fi
	done_msg=$(ctl "$orch/threads" | json "$thread_js.some(m => m.content.startsWith('✅ **Done.**')) ? 'yes' : ''" 2>/dev/null || true)
	if [ -n "$done_msg" ] && [ -z "$listed" ] && [ -n "$seen" ]; then break; fi
	sleep 0.2
done
ask_ms=$(($(now_ms) - start))
[ -n "$seen" ] || fail "no worker container appeared on $workers_net"
set -- $seen
[ $# = 1 ] || fail "$# worker containers appeared for one run:$seen"
worker="$1"
# The worker joined the workers network only, never the stack network with web on it (F6).
grep -qE "^$worker .*  networks=\[?$workers_net\]?  " "$work/listed" || fail "worker $worker is not on $workers_net alone: $(cat "$work/listed")"
[ -n "$done_msg" ] || fail "the answer did not reach thread $thread"
[ -z "$(workers '{{.Names}}')" ] || fail "worker containers remain on $workers_net"
echo "== after the run: podman ps -a --filter label=askbot.role=worker --filter network=$workers_net"
echo "  (none)"

echo "== thread $thread (bot messages)"
ctl "$orch/threads" | json "$thread_js.map(m => [m.content.split('\n')[0], ...m.files.map(f => '  [file] ' + f), ...(m.answer ? ['  answer.md: ' + m.answer.trim()] : [])].join('\n')).join('\n')" | sed 's/^/  /'
echo
answers=$(ctl "$orch/threads" | json "$thread_js.filter(m => m.files.includes('answer.md')).map(m => m.answer)")
[ "$answers" = '["Fixture slow answer."]' ] || fail "expected exactly one answer.md with the fixture's answer, got $answers"
run=$(ctl "$orch/state" | json "d.runs.filter(r => r.thread === '$thread').map(r => r.state + '/' + r.outcome + ' on ' + r.worker)")
echo "  runs: $run"
[ "$run" = "[\"finished/succeeded on $worker\"]" ] || fail "expected one succeeded run on $worker, got $run"

echo "== worker events ($worker)"
# Read afterwards: a live `podman events` stream over the remote connection may not have flushed the last events yet.
for _ in $(seq 1 20); do
	$P events --since "$events_since" --until 0s --filter label=askbot.role=worker \
		--format '{{.TimeNano}} {{.Status}} {{.Name}}' | awk -v w="$worker" '$3 == w' >"$work/events"
	grep -q ' remove ' "$work/events" && break
	sleep 0.5
done
while read -r ns event name; do
	echo "  $(date -r $((ns / 1000000000)) +%T 2>/dev/null || date -d @$((ns / 1000000000)) +%T) $event $name"
done <"$work/events"
created=$(awk '$2 == "create" { print $1; exit }' "$work/events")
removed=$(awk '$2 == "remove" { print $1; exit }' "$work/events")
[ -n "$created" ] && [ -n "$removed" ] || fail "missing create/remove events for $worker"
worker_ms=$(( (removed - created) / 1000000 ))

echo "== orchestrator and launcher log lines for the run"
compose logs --no-color orchestrator launcher | grep -E '"(ask chat started|run pending|run claimed|run finished|worker connected|worker disconnected|starting workers|worker container started|removed finished worker container)"' | cut -c1-260 | sed 's/^/  /'

echo "== launcher image against the rootful socket ($R, $rootful_sock)"
if [ "${BUILD:-1}" = 1 ]; then $R build -q -t "$image" "$root" >/dev/null; fi
set +e
out=$($R run --rm --user 0 --security-opt label=disable -v "$rootful_sock:/run/podman/podman.sock" \
	-v "$work/secrets/askbot_scale_token:/run/secrets/askbot_scale_token:ro" \
	-e ASKBOT_ROLE=launcher -e ASKBOT_IMAGE="$image" -e ASKBOT_WORKER_NETWORK="$net" \
	-e ASKBOT_SCALE_TOKEN_FILE=/run/secrets/askbot_scale_token "$image" launcher 2>&1)
code=$?
set -e
echo "$out" | sed 's/^/  /'
[ "$code" = 2 ] || fail "rootful socket: the launcher exited $code, expected 2"
case "$out" in *'the Podman socket is rootful (LCH-01)'*) ;; *) fail "rootful socket: no LCH-01 refusal logged" ;; esac
echo "launcher exit=$code"


echo "== timings"
echo "  stack up -d to all healthy: $(secs $up_ms)"
echo "  worker container create to remove: $(secs $worker_ms) (the fixture holds the run $hold s)"
echo "  /ask to answer posted and worker gone: $(secs $ask_ms)"
echo "PASS"

#!/usr/bin/env bash
# Helm chart install smoke test on kind with KEDA (architecture §7.3, requirements OPS-07, OPS-08, SEC-15/16).
#   test/e2e/k8s/install-smoke.sh
# 1. Builds localhost/askbot:dev and the e2e scenario image localhost/askbot-e2e:dev (test/e2e/k8s/Containerfile) on the
#    rootful Podman engine (BUILD=0 reuses them), brings up the shared kind cluster with test/e2e/k8s/kind.sh and loads
#    the e2e image.
# 2. Shows the chart's KEDA check: `helm template` without the ScaledJob API fails with the OPS-08 message, and renders
#    against the cluster's own API list (`--validate`), which has it.
# 3. `helm install --wait` of the real chart with small resources (worker.maxReplicas 2) into its own namespace, with
#    only the image swapped for the e2e one (image.repository/tag): its `orchestrator` is the scenario orchestrator
#    (real internals, fake Discord), its `worker` a real worker with the fixture agent host; web, the probes and
#    `askbot health` are the release image's. Prints the objects, the orchestrator's /readyz body and NOTES.
# 4. Through a port-forward to the web Service: /setup with the setup token from `kubectl logs deploy/<orchestrator>`;
#    the scenario orchestrator then seeds its settings (one ask channel, one allowed user) and the engine starts.
# 5. `/ask` in the fake ask channel (the e2e control API through a port-forward to the orchestrator). The run goes to a
#    real KEDA worker Job pod of the chart's ScaledJob: exactly one must appear and become Ready (claimed), the answer
#    (`answer.md`) and "Done" must reach the thread, and no worker pod may remain (Job TTL 60 s).
# 6. NetworkPolicies (SEC-15, F5): a pod labelled as a worker reaches orchestrator:8081 and the public npm registry but
#    neither web:8080 nor another pod's address (CoreDNS's readiness port); an unlabelled pod reaches neither AskBot
#    service.
# 7. `helm upgrade` (worker.maxReplicas 3) keeps the generated Secret's values: the restarted orchestrator opens the
#    vault with the same master key and its engine runs again (SEC-16).
# 8. Uninstalls and deletes the namespace (KEEP=1 leaves it; the cluster always stays: kind.sh down removes it).
# Env: IMAGE (default localhost/askbot:dev), E2E_IMAGE (default localhost/askbot-e2e:dev), BUILD (default 1),
# ROOTFUL_PODMAN (default `podman --connection podman-machine-default-root`), HELM (default .tools/helm, else helm on
# PATH), NAMESPACE (default askbot-smoke), RELEASE (default askbot), WEB_PORT (default 18090), ORCH_PORT (default
# 18091), HOLD_SECONDS (default 8: how long the fixture holds the run, so the pod's Ready shows), KEEP.
set -euo pipefail

root="$(cd "$(dirname "$0")/../../.." && pwd)"
image="${IMAGE:-localhost/askbot:dev}"
e2e_image="${E2E_IMAGE:-localhost/askbot-e2e:dev}"
R="${ROOTFUL_PODMAN:-podman --connection podman-machine-default-root}"
helm="${HELM:-$root/.tools/helm}"
[ -x "$helm" ] || helm="$(command -v helm)" || { echo "FAIL: no helm at $helm or on PATH" >&2; exit 1; }
ns="${NAMESPACE:-askbot-smoke}"
release="${RELEASE:-askbot}"
port="${WEB_PORT:-18090}"
orch_port="${ORCH_PORT:-18091}"
hold="${HOLD_SECONDS:-8}"
chart="$root/deploy/helm/askbot"
ctx=kind-askbot-e2e
k="kubectl --context $ctx -n $ns"
base="http://127.0.0.1:$port"
ctl_base="http://127.0.0.1:$orch_port/internal/admin/e2e"
work="$(mktemp -d)"
forward_pid=""
orch_forward_pid=""
# The chart's object names for release "askbot" (fullname = the release name when it contains the chart name).
case "$release" in *askbot*) full="$release" ;; *) full="$release-askbot" ;; esac
orch="$full-orchestrator"
web="$full-web"
worker_sel="app.kubernetes.io/instance=$release,app.kubernetes.io/component=worker"

now_ms() { bun -e 'process.stdout.write(String(Date.now()))'; }
secs() { awk -v ms="$1" 'BEGIN { printf "%.1f s", ms / 1000 }'; }
# The scenario orchestrator's control API (test/e2e/k8s/orchestrator.ts), with the web token.
ctl() { curl -s --max-time 10 -H "authorization: Bearer $web_token" -H 'content-type: application/json' "$@"; }
# `$1` of a JSON document on stdin (a JS expression over `d`).
json() { bun -e "const d = await Bun.stdin.json(); const v = $1; process.stdout.write(typeof v === 'string' ? v : JSON.stringify(v))"; }

teardown() {
	"$helm" --kube-context "$ctx" -n "$ns" uninstall "$release" --wait >/dev/null 2>&1 || true
	kubectl --context "$ctx" delete namespace "$ns" --ignore-not-found --wait=true >/dev/null 2>&1 || true
}

cleanup() {
	code=$?
	for pid in $forward_pid $orch_forward_pid; do kill "$pid" 2>/dev/null || true; done
	if [ "${KEEP:-0}" = 1 ]; then
		echo "KEEP=1: release $release left in namespace $ns; remove with: $helm --kube-context $ctx -n $ns uninstall $release && kubectl --context $ctx delete namespace $ns"
	else
		teardown
	fi
	rm -rf "$work"
	exit $code
}
trap cleanup EXIT

fail() {
	echo "FAIL: $*" >&2
	echo "== pods" >&2
	$k get pods -o wide >&2 2>&1 || true
	echo "== orchestrator log (last 40 lines)" >&2
	$k logs "deploy/$orch" --tail 40 >&2 2>&1 || true
	echo "== events (last 30)" >&2
	$k get events --sort-by .lastTimestamp 2>/dev/null | tail -30 >&2 || true
	exit 1
}

# GET http://127.0.0.1:<port><path> from inside a Deployment's container (the image has no curl).
in_pod() { $k exec "deploy/$1" -- bun -e "const r = await fetch('http://127.0.0.1:$2$3'); console.log(r.status, await r.text())"; }

# kubectl port-forward <target> <local>:<remote> in the background until <url> answers; its pid in $forwarded.
port_forward() {
	$k port-forward "$1" "$2" >>"$work/forward.log" 2>&1 &
	forwarded=$!
	for _ in $(seq 1 50); do
		[ "$(curl -s -o /dev/null -w '%{http_code}' "$3" || true)" = 200 ] && return
		sleep 0.2
	done
	fail "port-forward $1 $2: $3 does not answer"
}

if [ "${BUILD:-1}" = 1 ]; then
	echo "== build $image and $e2e_image (rootful engine)"
	$R build -q -t "$image" "$root" | sed 's/^/  /'
	$R build -q -f "$root/test/e2e/k8s/Containerfile" --ignorefile "$root/test/e2e/k8s/Containerfile.containerignore" \
		--build-arg "BASE_IMAGE=$image" -t "$e2e_image" "$root" | sed 's/^/  /'
fi

echo "== kind cluster (test/e2e/k8s/kind.sh up $e2e_image)"
"$root/test/e2e/k8s/kind.sh" up "$e2e_image" 2>&1 | grep -E '^kind.sh:|successfully rolled out' | sed 's/^/  /'
kubectl --context "$ctx" version 2>/dev/null | sed 's/^/  /'
echo "  KEDA $(kubectl --context "$ctx" -n keda get deploy keda-operator -o jsonpath='{.metadata.labels.app\.kubernetes\.io/version}')"

echo "== helm lint"
"$helm" lint "$chart" --strict | sed 's/^/  /'

echo "== KEDA check (OPS-08)"
set +e
out=$("$helm" template "$release" "$chart" -n "$ns" 2>&1)
code=$?
set -e
echo "  helm template without the ScaledJob API: exit $code"
echo "$out" | grep -m1 'KEDA is not installed' | sed 's/^/  /'
[ "$code" != 0 ] && [[ "$out" == *"KEDA is not installed: this cluster has no keda.sh/v1alpha1 ScaledJob API"* ]] || fail "helm template without KEDA did not fail with the KEDA message"
kubectl --context "$ctx" api-resources --api-group keda.sh 2>/dev/null | sed 's/^/  /'
"$helm" --kube-context "$ctx" template "$release" "$chart" -n "$ns" --validate >/dev/null || fail "helm template --validate against the cluster failed"
echo "  helm template --validate against the cluster (its API list has keda.sh/v1alpha1/ScaledJob): ok"

echo "== clean namespace $ns"
teardown

cat >"$work/values.yaml" <<EOF
image:
  repository: ${e2e_image%:*}
  tag: ${e2e_image##*:}
  pullPolicy: Never
orchestrator:
  resources: { requests: { cpu: 100m, memory: 256Mi }, limits: { memory: 1Gi } }
  persistence: { size: 1Gi }
web:
  resources: { requests: { cpu: 50m, memory: 128Mi }, limits: { memory: 512Mi } }
worker:
  maxReplicas: 2
  diskLimit: 1Gi
  resources: { requests: { cpu: 100m, memory: 256Mi, ephemeral-storage: 100Mi }, limits: { memory: 1Gi } }
EOF

echo "== helm install $release -n $ns (values: $(tr '\n' ' ' <"$work/values.yaml" | tr -s ' ' | cut -c1-120)...)"
start=$(now_ms)
"$helm" --kube-context "$ctx" install "$release" "$chart" -n "$ns" --create-namespace -f "$work/values.yaml" --wait --timeout 5m >"$work/install.log" 2>&1 \
	|| { cat "$work/install.log"; fail "helm install failed"; }
install_ms=$(($(now_ms) - start))
sed -n '1,6p' "$work/install.log" | sed 's/^/  /'
echo "  NOTES:"
sed -n '/^NOTES:/,$p' "$work/install.log" | sed '1d; s/^/    /'
$k rollout status "deploy/$orch" --timeout 60s >/dev/null && $k rollout status "deploy/$web" --timeout 60s >/dev/null || fail "deployments not ready"
echo "orchestrator and web Ready $(secs $install_ms) after helm install"
$k get deploy,svc,pvc,secret,networkpolicy,scaledjob,triggerauthentication 2>&1 | sed 's/^/  /'
secret_before=$($k get secret "$full" -o jsonpath='{.data}' | shasum -a 256 | cut -c1-16)
scale_before=$($k get secret "$full" -o jsonpath='{.data.scale-token}')
# Not Ready until KEDA's first successful /internal/scale poll after the orchestrator listens.
$k wait --for condition=Ready "scaledjob/$full-worker" --timeout 60s >/dev/null || fail "the ScaledJob is not Ready"
$k get scaledjob "$full-worker" | sed 's/^/  /'

echo "== secret files in the orchestrator (readable by 10001 only)"
$k exec "deploy/$orch" -- sh -c 'id; ls -lL /run/secrets/' | sed 's/^/  /'

echo "== orchestrator /readyz (before setup: limits null)"
in_pod "$orch" 8081 /readyz | sed 's/^/  /'

echo "== port-forward svc/$web $port:8080"
port_forward "svc/$web" "$port:8080" "$base/healthz"
forward_pid=$forwarded
echo "  web /healthz: $(curl -s "$base/healthz")"


echo "== /setup with the setup token from kubectl logs deploy/$orch"
token=$($k logs "deploy/$orch" | grep -o '"setupToken":"[^"]*"' | tail -1 | cut -d'"' -f4)
[ -n "$token" ] || fail "no setup token in the orchestrator log"
password="e2e-$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"
jar="$work/cookies"
post() { curl -s -b "$jar" -c "$jar" -o "$work/body.html" -w '%{http_code} %{redirect_url}' -H "Origin: $base" "$@"; }
out=$(post --data-urlencode "token=$token" --data-urlencode username=admin --data-urlencode "password=$password" --data-urlencode "confirm=$password" "$base/setup")
[ "$out" = "303 $base/" ] || fail "setup answered $out"
echo "admin created"

echo "== port-forward svc/$orch $orch_port:8081 (the e2e control API)"
web_token=$($k get secret "$full" -o jsonpath='{.data.web-api-token}' | base64 -d)
port_forward "svc/$orch" "$orch_port:8081" "http://127.0.0.1:$orch_port/livez"
orch_forward_pid=$forwarded
phase=""
for _ in $(seq 1 60); do
	phase=$(ctl "$ctl_base/state" | json d.phase 2>/dev/null || true)
	[ "$phase" = running ] && break
	sleep 0.5
done
[ "$phase" = running ] || fail "the engine is not running after setup (phase ${phase:-unknown})"
echo "engine running with the seeded e2e settings"

echo "== /ask in the fake ask channel (fixture:slow, held $hold s): a KEDA worker Job pod runs it"
[ -z "$($k get pods -l "$worker_sel" -o name)" ] || fail "worker pods exist before the ask"
start=$(now_ms)
out=$(ctl -X POST -d "{\"prompt\":\"What does AskBot do? fixture:slow fixture-hold-seconds:$hold\"}" "$ctl_base/ask")
thread=$(echo "$out" | json 'd.thread ?? ""')
[ -n "$thread" ] || fail "/ask was refused: $out"
echo "thread $thread: $(echo "$out" | json d.reply)"
thread_js="(d.find(t => t.id === '$thread')?.messages.filter(m => m.bot) ?? [])"
seen=""
ready=""
answered=""
last=""
for _ in $(seq 1 300); do
	listed=$($k get pods -l "$worker_sel" --no-headers -o custom-columns='NAME:.metadata.name,PHASE:.status.phase,READY:.status.conditions[?(@.type=="Ready")].status' 2>/dev/null || true)
	if [ -n "$listed" ] && [ "$listed" != "$last" ]; then
		echo "  $(date +%T) $(echo "$listed" | tr '\n' ' ')"
		last="$listed"
	fi
	for name in $(echo "$listed" | awk '{ print $1 }'); do
		case " $seen " in *" $name "*) ;; *) seen="$seen $name" ;; esac
	done
	echo "$listed" | awk '$3 == "True"' | grep -q . && ready=1
	answered=$(ctl "$ctl_base/threads" | json "$thread_js.some(m => m.content.startsWith('✅ **Done.**')) ? 'yes' : ''" 2>/dev/null || true)
	if [ -n "$answered" ] && [ -n "$seen" ]; then break; fi
	sleep 0.5
done
done_ms=$(($(now_ms) - start))
[ -n "$seen" ] || fail "no worker pod appeared"
[ -n "$answered" ] || fail "the answer did not reach thread $thread"
[ -n "$ready" ] || fail "the worker pod never became Ready (health --claimed)"
echo "answered $(secs $done_ms) after /ask; the worker pod was Ready (claimed) while it ran"
echo "== thread $thread (bot messages)"
ctl "$ctl_base/threads" | json "$thread_js.map(m => [m.content.split('\n')[0], ...m.files.map(f => '  [file] ' + f), ...(m.answer ? ['  answer.md: ' + m.answer.trim()] : [])].join('\n')).join('\n')" | sed 's/^/  /'
echo
answers=$(ctl "$ctl_base/threads" | json "$thread_js.filter(m => m.files.includes('answer.md')).map(m => m.answer)")
[ "$answers" = '["Fixture slow answer."]' ] || fail "expected exactly one answer.md with the fixture's answer, got $answers"

echo "== worker pods until none remain (Job ttlSecondsAfterFinished 60)"
for _ in $(seq 1 240); do
	listed=$($k get pods -l "$worker_sel" --no-headers -o custom-columns='NAME:.metadata.name,PHASE:.status.phase' 2>/dev/null || true)
	for name in $(echo "$listed" | awk '{ print $1 }'); do
		case " $seen " in *" $name "*) ;; *) seen="$seen $name" ;; esac
	done
	if [ "$listed" != "$last" ]; then
		echo "  $(date +%T) ${listed:-(none)}" | tr '\n' ' '
		echo
		last="$listed"
	fi
	[ -z "$listed" ] && break
	sleep 1
done
[ -z "$listed" ] || fail "worker pods remain: $listed"
gone_ms=$(($(now_ms) - start))
set -- $seen
[ $# = 1 ] || fail "$# worker pods appeared for one run:$seen"
run=$(ctl "$ctl_base/state" | json "d.runs.filter(r => r.thread === '$thread').map(r => r.state + '/' + r.outcome + ' on ' + r.worker)")
echo "  runs: $run"
[ "$run" = "[\"finished/succeeded on $1\"]" ] || fail "expected one succeeded run on $1, got $run"
echo "exactly one worker pod ($1); none left $(secs $gone_ms) after /ask"
$k logs "deploy/$orch" | grep -E '"(ask chat started|run pending|run claimed|run finished|worker connected|worker disconnected)"' | tail -8 | cut -c1-220 | sed 's/^/  /'

echo "== orchestrator /readyz (after setup: limits and warnings)"
in_pod "$orch" 8081 /readyz | sed 's/^/  /'

echo "== NetworkPolicies (SEC-15, F5)"
# A cluster address the ingress rules leave open: CoreDNS's readiness port. (The Kubernetes API is no such target on a
# one-node kind cluster: it runs on the node itself, and pod-to-own-node traffic is not filtered.)
dns_ip=$(kubectl --context "$ctx" -n kube-system get pod -l k8s-app=kube-dns -o jsonpath='{.items[0].status.podIP}')
[ -n "$dns_ip" ] || fail "no CoreDNS pod address"
probe() {
	# $1 pod name, $2 extra labels; prints "<target> <status|blocked>" for orchestrator:8081, web:8080, CoreDNS:8181 and
	# the npm registry.
	$k run "$1" --image "$e2e_image" --image-pull-policy Never --restart Never --labels "$2" \
		--overrides '{"spec":{"automountServiceAccountToken":false,"enableServiceLinks":false,"securityContext":{"runAsUser":10001,"runAsNonRoot":true}}}' \
		--command -- bun -e "for (const u of ['http://$orch:8081/livez', 'http://$web:8080/healthz', 'http://$dns_ip:8181/ready', 'https://registry.npmjs.org/-/ping']) { try { const r = await fetch(u, { signal: AbortSignal.timeout(5000) }); console.log(u, r.status) } catch { console.log(u, 'blocked') } }" >/dev/null
	$k wait --for jsonpath='{.status.phase}'=Succeeded "pod/$1" --timeout 90s >/dev/null || fail "probe pod $1 did not finish"
	$k logs "$1" | sed "s/^/  $1: /"
	$k delete pod "$1" --wait=false >/dev/null
}
probe np-as-worker "app.kubernetes.io/name=askbot,app.kubernetes.io/instance=$release,app.kubernetes.io/component=worker" | tee "$work/np-worker"
probe np-other "app=other" | tee "$work/np-other"
grep -q "$orch:8081/livez 200" "$work/np-worker" || fail "a worker cannot reach the orchestrator"
grep -q "$web:8080/healthz blocked" "$work/np-worker" || fail "a worker can reach web"
grep -q "$dns_ip:8181/ready blocked" "$work/np-worker" || fail "a worker can reach another pod's address (CoreDNS :8181)"
grep -qE "registry.npmjs.org/-/ping [0-9]+" "$work/np-worker" || fail "a worker cannot reach the npm registry"
grep -qE "$dns_ip:8181/ready [0-9]+" "$work/np-other" || fail "the cluster-address check is void: an unrestricted pod cannot reach CoreDNS :8181 either"
grep -q "$orch:8081/livez blocked" "$work/np-other" || fail "an unlabelled pod can reach the orchestrator"
grep -q "$web:8080/healthz blocked" "$work/np-other" || fail "an unlabelled pod can reach web"

echo "== helm upgrade (worker.maxReplicas=3) keeps the generated secrets"
# The upgrade replaces the orchestrator pod, which ends the port-forwards anyway.
for pid in $forward_pid $orch_forward_pid; do
	kill "$pid" 2>/dev/null || true
	wait "$pid" 2>/dev/null || true
done
forward_pid=""
orch_forward_pid=""
"$helm" --kube-context "$ctx" upgrade "$release" "$chart" -n "$ns" -f "$work/values.yaml" --set worker.maxReplicas=3 --wait --timeout 5m >/dev/null || fail "helm upgrade failed"
$k rollout status "deploy/$orch" --timeout 120s >/dev/null || fail "the upgraded orchestrator is not ready"
$k get deploy "$orch" -o jsonpath='{.spec.template.spec.containers[0].env[?(@.name=="ASKBOT_WORKER_CAPACITY")].value}' | grep -qx 3 || fail "the upgrade did not apply worker.maxReplicas=3"
secret_after=$($k get secret "$full" -o jsonpath='{.data}' | shasum -a 256 | cut -c1-16)
scale_after=$($k get secret "$full" -o jsonpath='{.data.scale-token}')
echo "  revision $("$helm" --kube-context "$ctx" -n "$ns" status "$release" -o json | bun -e 'process.stdout.write(String((await Bun.stdin.json()).version))')"
echo "  secret data sha256 before $secret_before, after $secret_after"
echo "  scale-token before ${scale_before:0:12}..., after ${scale_after:0:12}..."
[ "$secret_before" = "$secret_after" ] || fail "helm upgrade changed the generated secrets"
# The new orchestrator opened the vault with the kept master key: its engine runs without a login (SEC-16).
phase=""
for _ in $(seq 1 60); do
	phase=$(in_pod "$orch" 8081 /readyz 2>/dev/null | sed 's/^[0-9]* //' | json 'd.phase' 2>/dev/null || true)
	[ "$phase" = running ] && break
	sleep 1
done
in_pod "$orch" 8081 /readyz | sed 's/^/  /'
[ "$phase" = running ] || fail "the upgraded orchestrator's engine is not running (phase ${phase:-unknown}): the vault did not open"

echo "== timings"
echo "  helm install to orchestrator + web Ready: $(secs $install_ms)"
echo "  /ask to answer: $(secs $done_ms); to no worker pod left: $(secs $gone_ms)"
echo "PASS"

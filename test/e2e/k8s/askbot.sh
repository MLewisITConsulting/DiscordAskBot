#!/bin/sh
# `askbot` in the e2e scenario image (test/e2e/k8s/Containerfile). The chart passes the role as the container argument
# and the launcher starts workers as `askbot worker`, so replacing the CLI here reaches both:
#   orchestrator  the scenario orchestrator (test/e2e/k8s/orchestrator.ts): real internals, fake Discord
#   worker        a real worker process running the fixture agent host (test/fixtures/worker-process.ts), with the
#                 worker token file, the pod or container name as its id and ASKBOT_WORKER_DISK as its scratch limit,
#                 so `askbot health [--claimed]` works as usual
#   anything else the real CLI (web, launcher, health, ...)
set -eu
case "${1:-}" in
orchestrator)
	shift
	exec bun /app/test/e2e/k8s/orchestrator.ts "$@"
	;;
worker)
	shift
	TEST_WORKER_TOKEN="$(cat "${ASKBOT_WORKER_TOKEN_FILE:?ASKBOT_WORKER_TOKEN_FILE must be set}")"
	# One claim per worker id, ever: the pod or container name, like `askbot worker`.
	TEST_WORKER_ID="${HOSTNAME:?}"
	TEST_CLAIM_TIMEOUT_MS="${TEST_CLAIM_TIMEOUT_MS:-15000}"
	export TEST_WORKER_TOKEN TEST_WORKER_ID TEST_CLAIM_TIMEOUT_MS
	if [ -n "${ASKBOT_WORKER_DISK:-}" ]; then
		# Bytes, as `askbot worker` reads it (the chart writes e.g. `2g`, the launcher a byte count).
		TEST_DISK_LIMIT="$(bun -e 'const { parseSize } = await import("/app/src/shared/env.ts"); console.log(parseSize("ASKBOT_WORKER_DISK", process.env.ASKBOT_WORKER_DISK))')"
		export TEST_DISK_LIMIT
	fi
	exec bun /app/test/fixtures/worker-process.ts "$@"
	;;
*)
	exec bun /app/src/cli.ts "$@"
	;;
esac

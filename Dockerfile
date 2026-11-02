# The one AskBot image (architecture §7.1, requirements OPS-01): the role is the command,
# `askbot orchestrator|web|worker|launcher|health`. Everything runs as `askbot` (10001:10001); no entrypoint runs as root.
#
# Build args:
#   ASKBOT_OMP         latest (default): npm's latest omp with the package.json pin as fallback (UPD-01);
#                        pin: the pin only (CI MUST test it); or an exact version to try instead of npm's latest.
#   ASKBOT_VERSION     build version shown on the home page and in health bodies; empty = package.json's version.
#   ASKBOT_COMMIT      git commit the image is built from.
#   ASKBOT_BUILD_DATE  build time (ISO 8601).
#   CODE_SERVER_VERSION  code-server release (spike S4 tested 4.143.1).

# The bundled VS Code extension, packaged by scripts/build-vsix.ts (WEB-14).
FROM docker.io/oven/bun:1.4.2-debian AS vsix
WORKDIR /src
COPY scripts/build-vsix.ts scripts/
COPY scripts/vsix/package.json scripts/vsix/bun.lock scripts/vsix/
COPY vscode/extension/ vscode/extension/
RUN bun scripts/build-vsix.ts

# code-server from the release tarball, in its own stage so curl stays out of the image (spike S4). Only JSON, YAML and
# Markdown support and the two default themes (no code) stay; every other built-in extension (debuggers, task providers,
# git, npm, copilot chat, ...) is deleted, because code-server has no per-extension disable flag. The bundled extension is
# installed as root into an extensions dir that holds only it, so askbot can neither add nor remove extensions.
FROM docker.io/oven/bun:1.4.2-debian AS code-server
RUN apt-get update \
	&& apt-get install -y --no-install-recommends ca-certificates curl \
	&& rm -rf /var/lib/apt/lists/*
ARG CODE_SERVER_VERSION=4.143.1
RUN arch="$(dpkg --print-architecture)" \
	&& mkdir /opt/code-server \
	&& curl -fsSL "https://github.com/coder/code-server/releases/download/v${CODE_SERVER_VERSION}/code-server-${CODE_SERVER_VERSION}-linux-${arch}.tar.gz" \
		| tar -xz -C /opt/code-server --strip-components=1 \
	&& cd /opt/code-server/lib/vscode/extensions \
	&& for d in */; do \
		case "${d%/}" in json|json-language-features|yaml|markdown-basics|markdown-language-features|theme-defaults|theme-seti) ;; \
		*) rm -rf "$d" ;; esac; \
	done \
	&& /opt/code-server/bin/code-server --version
COPY --from=vsix /src/dist/askbot.vsix /tmp/askbot.vsix
RUN /opt/code-server/bin/code-server --user-data-dir /tmp/cs-build --extensions-dir /opt/askbot/vscode-extensions \
		--install-extension /tmp/askbot.vsix \
	&& rm -rf /tmp/cs-build /tmp/askbot.vsix \
	&& ls -la /opt/askbot/vscode-extensions

FROM docker.io/oven/bun:1.4.2-debian
# git: the orchestrator's mirrors and the workers' checkouts; procps: the agent's process tools and `pgrep` for operators.
RUN apt-get update \
	&& apt-get install -y --no-install-recommends ca-certificates git procps \
	&& rm -rf /var/lib/apt/lists/*

# askbot's login shell is nologin: VS Code offers every shell in /etc/shells as a terminal profile, so it lists only
# nologin (WEB-14). /state (orchestrator) and /home/askbot (web) are owned by askbot so that named volumes mounted
# there inherit the ownership; /run/askbot is the worker's run-local root (ASKBOT_WORKER_RUN_DIR), where the
# launcher mounts a tmpfs and Helm a memory emptyDir.
RUN groupadd --gid 10001 askbot \
	&& useradd --uid 10001 --gid 10001 --create-home --home-dir /home/askbot --shell /usr/sbin/nologin askbot \
	&& printf '/usr/sbin/nologin\n' > /etc/shells \
	&& install -d -o 10001 -g 10001 -m 0700 /state /run/askbot \
	&& printf '#!/bin/sh\nexec bun /app/src/cli.ts "$@"\n' > /usr/local/bin/askbot \
	&& chmod 0755 /usr/local/bin/askbot

# Root-owned and read-only to askbot: code-server, the locked user settings and tasks (symlinked at every start by
# src/web/vscode.ts) and the extensions dir with only the bundled extension.
COPY --from=code-server /opt/code-server/ /opt/code-server/
COPY --from=code-server /opt/askbot/vscode-extensions/ /opt/askbot/vscode-extensions/
COPY vscode/locked/ /opt/askbot/vscode/
RUN chmod -R a+rX,go-w /opt/askbot

# omp: npm's latest, not the one in bun.lock, with package.json's pin as the fallback (UPD-01). The layer cache keys ADD
# on the downloaded document, so this reinstalls exactly when a new omp is published.
WORKDIR /app
COPY package.json bun.lock ./
COPY src/shared/log.ts src/shared/ompPins.ts src/shared/
COPY scripts/omp-latest.ts scripts/
ARG ASKBOT_OMP=latest
ADD https://registry.npmjs.org/@oh-my-pi/pi-coding-agent/latest /tmp/omp-latest.json
RUN BUN_INSTALL_CACHE_DIR=/tmp/bun-cache ASKBOT_OMP="${ASKBOT_OMP}" bun scripts/omp-latest.ts install /tmp/omp-latest.json \
	&& rm -rf /tmp/bun-cache /tmp/omp-latest.json
COPY src/ src/
# Loads the app's omp entry modules with the installed omp and logs which omp the image has and why; reinstalls the pin
# when the candidate does not load.
RUN BUN_INSTALL_CACHE_DIR=/tmp/bun-cache bun scripts/omp-latest.ts verify && rm -rf /tmp/bun-cache

# The app identity (§7.1) over the final sources, lockfile and package.json, and the build info. The RUN reads the args:
# buildah caches steps by text, so without it a rebuild with a new version would keep the old identity.
ARG ASKBOT_VERSION=
ARG ASKBOT_COMMIT=unknown
ARG ASKBOT_BUILD_DATE=
RUN ASKBOT_VERSION="${ASKBOT_VERSION}" ASKBOT_COMMIT="${ASKBOT_COMMIT}" ASKBOT_BUILD_DATE="${ASKBOT_BUILD_DATE}" \
	bun src/shared/version.ts --write-identity /app/IDENTITY

ENV ASKBOT_VERSION=${ASKBOT_VERSION} \
	ASKBOT_COMMIT=${ASKBOT_COMMIT} \
	ASKBOT_BUILD_DATE=${ASKBOT_BUILD_DATE} \
	ASKBOT_HOME=/home/askbot \
	ASKBOT_STATE_DIR=/state \
	ASKBOT_OMP_RUNTIME_DIR=/state/omp-runtime \
	ASKBOT_WORKER_RUN_DIR=/run/askbot \
	ASKBOT_WEB_HOST=0.0.0.0 \
	ASKBOT_WEB_PORT=8080 \
	ASKBOT_INTERNAL_HOST=0.0.0.0 \
	ASKBOT_INTERNAL_PORT=8081 \
	HOME=/home/askbot \
	LANG=C.UTF-8

USER 10001:10001
WORKDIR /home/askbot
# web: 8080 (UI, /healthz); orchestrator: 8081 (internal API, /readyz /livez /healthz).
EXPOSE 8080 8081
ENTRYPOINT ["askbot"]

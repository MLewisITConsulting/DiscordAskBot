{{- define "askbot.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/* Release-scoped base name; objects append their component (-orchestrator, -web, -worker). */}}
{{- define "askbot.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 50 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 50 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 50 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{- define "askbot.selectorLabels" -}}
app.kubernetes.io/name: {{ include "askbot.name" .root }}
app.kubernetes.io/instance: {{ .root.Release.Name }}
app.kubernetes.io/component: {{ .component }}
{{- end }}

{{/* Labels of an object; `.component` is orchestrator, web or worker (or omitted for shared objects). */}}
{{- define "askbot.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .root.Chart.Name .root.Chart.Version | replace "+" "_" }}
app.kubernetes.io/name: {{ include "askbot.name" .root }}
app.kubernetes.io/instance: {{ .root.Release.Name }}
app.kubernetes.io/version: {{ .root.Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .root.Release.Service }}
{{- with .component }}
app.kubernetes.io/component: {{ . }}
{{- end }}
{{- end }}

{{- define "askbot.image" -}}
{{- printf "%s:%s" .Values.image.repository (default .Chart.AppVersion .Values.image.tag) }}
{{- end }}

{{- define "askbot.workerImage" -}}
{{- printf "%s:%s" (default .Values.image.repository .Values.worker.image.repository) (default (default .Chart.AppVersion .Values.image.tag) .Values.worker.image.tag) }}
{{- end }}

{{- define "askbot.secretName" -}}
{{- default (include "askbot.fullname" .) .Values.secrets.existingSecret }}
{{- end }}

{{- define "askbot.orchestratorService" -}}
{{- printf "%s-orchestrator" (include "askbot.fullname" .) }}
{{- end }}

{{- define "askbot.webService" -}}
{{- printf "%s-web" (include "askbot.fullname" .) }}
{{- end }}

{{/* The orchestrator's internal API, reachable from other namespaces (the KEDA operator). */}}
{{- define "askbot.orchestratorUrl" -}}
{{- printf "http://%s.%s.svc:8081" (include "askbot.orchestratorService" .) .Release.Namespace }}
{{- end }}

{{/* Egress rule: name lookups (port 53, UDP and TCP) at the peers in networkPolicy.dns (F5). */}}
{{- define "askbot.dnsEgress" -}}
- to:
    {{- toYaml .Values.networkPolicy.dns | nindent 4 }}
  ports:
    - port: 53
      protocol: UDP
    - port: 53
      protocol: TCP
{{- end }}

{{/* Egress rule: the orchestrator's internal API (F5). */}}
{{- define "askbot.orchestratorEgress" -}}
- to:
    - podSelector:
        matchLabels:
          {{- include "askbot.selectorLabels" (dict "root" . "component" "orchestrator") | nindent 10 }}
  ports:
    - port: 8081
      protocol: TCP
{{- end }}

{{/*
A secret volume with the given keys of the AskBot Secret, mounted at /run/secrets like compose's secrets.
Mode 0400; with fsGroup 10001 Kubernetes makes the files root:10001 0440, so only askbot (and root) can read them.
*/}}
{{- define "askbot.secretVolume" -}}
- name: secrets
  secret:
    secretName: {{ include "askbot.secretName" .root }}
    # 0400 in decimal: YAML 1.1 and 1.2 parsers read a leading-zero 0400 differently.
    defaultMode: 256
    items:
      {{- range .keys }}
      - key: {{ . }}
        path: askbot_{{ . | replace "-" "_" }}
      {{- end }}
{{- end }}

{{/*
Pod settings shared by every AskBot pod:
- no service account token: nothing in AskBot talks to the Kubernetes API, and agents must not;
- no service links: Kubernetes would inject <SERVICE>_PORT variables, and a Service named <release>-askbot-web
  turns into ASKBOT_WEB_PORT=tcp://..., which collides with AskBot's own settings;
- a shared process namespace, so that the pause container is PID 1 and reaps orphaned processes (compose's `init: true`).
*/}}
{{- define "askbot.podSpec" -}}
automountServiceAccountToken: false
enableServiceLinks: false
shareProcessNamespace: true
{{- with .Values.imagePullSecrets }}
imagePullSecrets:
  {{- toYaml . | nindent 2 }}
{{- end }}
securityContext:
  {{- toYaml .Values.podSecurityContext | nindent 2 }}
{{- end }}

{{- define "askbot.scheduling" -}}
{{- with .nodeSelector }}
nodeSelector:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- with .tolerations }}
tolerations:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- with .affinity }}
affinity:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- end }}

{{/* ASKBOT_WORKER_DISK from worker.diskLimit: the same binary size in Podman notation (20Gi -> 20g). */}}
{{- define "askbot.workerDisk" -}}
{{- $limit := toString .Values.worker.diskLimit }}
{{- if not (regexMatch "^[0-9]+(Ki|Mi|Gi|Ti)$" $limit) }}
{{- fail (printf "worker.diskLimit must be a whole number of Ki, Mi, Gi or Ti (e.g. 20Gi), got %q" $limit) }}
{{- end }}
{{- $limit | lower | trimSuffix "i" }}
{{- end }}

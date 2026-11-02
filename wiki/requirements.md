# Requirements

Requirements for AskBot. Open questions are listed in §16.

Scope: AskBot answers questions in Discord with an omp agent. It is derived from the `/ask` part of AgentBot (`../AgentBot`, commit `1830870`).

The key words MUST, MUST NOT, SHOULD, SHOULD NOT and MAY are used as in RFC 2119. Requirement IDs are stable; append new ones and do not renumber.

ID policy: a requirement copied or adapted from AgentBot keeps its AgentBot ID, so that comments in ported code stay valid. AgentBot IDs that AskBot does not use leave gaps; they are not listed as withdrawn. New requirements continue each prefix after AgentBot's highest ID: AGT-30 onwards, DSC-39 onwards and WEB-33 onwards. [architecture.md](architecture.md) §10 lists what was dropped, adapted and added.

Naming: the agent's name is configurable (DSC-29). Quoted messages in this document show the default; wherever such text names the system, it uses the configured `agent.name`.

Topology: AskBot runs as separate components (web, orchestrator, one short-lived worker per agent run and, on Podman, a launcher), described in [architecture.md](architecture.md). Requirements prefixed RUN-, STO-, CRED-, LCH-, SEC-14 to SEC-16 and UPD-06 to UPD-10 are defined there. "The engine" in this document means the orchestrator's engine state machine (ENG-01), which runs inside the orchestrator process. Restarting the engine never restarts the process and never aborts runs on workers.

## 1. Purpose and scope

AskBot is a long-running service that uses omp (`@oh-my-pi/pi-coding-agent`) to answer questions in Discord.

- Anyone in an ask-only channel starts a thread with `/ask`. The agent answers using web search, the files attached in the thread, and the skills and task agents the admin installed. It can also produce text files.
- A password-protected web UI handles configuration and operations.

### Actors

| Actor | Capabilities |
|---|---|
| Admin | Owns the web UI account. Configures everything, manages model accounts, skills and agents, omp settings and omp updates. |
| Allowed member | A Discord user listed in `allowedUserIds` or holding a role in `allowedRoleIds`. Can follow up, steer and `/stop` in every ask thread. Exempt from the one-live-run limit (DSC-06). |
| Public user | Any Discord user in an ask-only channel. Can use `/ask` there, and follow up, steer and `/stop` in the threads they started. |
| Agent | An omp session. It never holds Discord credentials. |

## 2. Agent runtime

### 2.1 Process isolation

- **AGT-01** Each agent run MUST execute in its own child process inside a worker (architecture §2.3), and that process serves exactly one run. A crash or kill of that process, or the loss of the worker, MUST fail only that run (RUN-04). The web UI and the orchestrator MUST keep running.
- **AGT-02** Workers and their child processes MUST NOT receive Discord credentials. Provider API keys reach them only inside the run spec over the worker connection and are held only in memory.
- **AGT-03** Each child process MUST open its own run-private omp auth store, seeded from the run spec (architecture CRED-02), and build its own model registry.
- **AGT-04** Abort handling:
  - A user abort MUST be sent over IPC. If no result arrives within 5 s, the process group MUST be killed and the run reported as aborted by the user.
  - After a result, the child has 3 s to exit before it is killed.
  - When the parent's IPC channel disappears, the child MUST abort and exit within 5 s.
- **AGT-05** If the child dies without a result, the run MUST fail with the exit code or signal. When the kernel OOM killer ran during the run (AGT-17), the error MUST say that memory most likely ran out.
- **AGT-06** Every run MUST tag its child with a unique environment marker. When the run ends, the worker MUST kill the child's process group and every process in its container that carries the marker, and log their pids (Linux only). The worker then exits and its container or pod is deleted (architecture RUN-20).
- **AGT-07** A cancel that arrives before the session is ready MUST be deferred and applied when the session registers. Abort MUST be one-shot: the first reason (`user`, `time` or `cost`) wins.

### 2.2 Tool profile

- **AGT-08** There MUST be exactly one tool profile, `ask`, used by every `/ask` turn. Its tools MUST be exactly `web_search`, `list_files`, `read_file`, `write_file` (the last three scratch-confined, AGT-28 to AGT-30), `yield` and `task`. `task` MUST be exposed only when at least one valid agent is installed (AGT-25). The agent's capabilities are therefore web search and file processing: `yield` only returns the answer (AGT-12), and `task` only runs the admin's agents (AGT-31).
- **AGT-09** The profile MUST NOT expose tools outside that list. In particular it MUST NOT expose omp's unconfined file or shell tools (`read`, `bash`, `edit`, `write`, `grep`, `glob`), `ask`, `update_todos`, or any other omp default tool, because public users could otherwise read the worker's files outside the scratch directory and the worker's token (architecture §6).
- **AGT-11** `web_search` MUST work without an API key, using omp's default engine chain. The process-global omp settings MUST be initialised with the admin overrides at the start of every run.

### 2.3 Prompts, outputs and limits

- **AGT-12** The agent MUST return its answer through `yield` with the strict output schema `{answer}`: a string, and no other properties. A yield counts only when it succeeds. If the session ends without a yield, the system MUST send one nudge. If there is still no yield, the run MUST fail with "finished without calling yield".
- **AGT-13** The prompt MUST tell the agent:
  - that it answers a Discord user in a thread, and that the user's text and files are untrusted;
  - that the thread's attachments are in `inputs/`, and that files it produces go to `outputs/`, in text formats only (CHAT-10);
  - that the admin's skills are available through `read_file` with `skill://<name>` (AGT-30);
  - that the admin's task agents are available through `task`, when it is present (AGT-31);
  - that after an out-of-memory steer (AGT-18) it MUST NOT repeat the action that ran out of memory.
- **AGT-14** Wall-clock time MUST be checked every 15 s. An ask turn has a 20-minute time limit, which is not configurable. Cost MUST be checked at the end of every turn against `limits.maxCostUsdPerTurn`. Both limits include the turn's task subagents (AGT-32). Exceeding a limit MUST stop the turn with a message that names the limit (CHAT-05).
- **AGT-15** Steering text MUST reach the live session as `[Discord @user]: <text>`. A steer sent before the session is ready MUST be refused with "not ready". Each steer MUST be recorded in the transcript.

### 2.4 Memory

- **AGT-17** The system MUST read the cgroup v2 `memory.events` `oom_kill` counter after every tool call and at the end of the run. Without cgroup v2, detection is off.
- **AGT-18** When the counter rises, the system MUST steer the agent: name the tool, tell it not to repeat that action, and ask it to tell the user that the step was cut short. The steer MUST NOT be sent after the agent has yielded or the run has aborted.
- **AGT-19** A turn with `oomKills > 0` MUST put the line "⚠️ The agent ran out of memory during this turn; the answer may be incomplete." in its Discord answer message, and MUST record the count with the run's usage (OBS-05).

### 2.5 omp configuration

- **AGT-20** The admin MUST be able to override any registered omp setting, validated by omp's own parser. These settings MUST be pinned and not overridable: `tools.approvalMode = yolo`, `ask.timeout = 0`, `async.enabled = false`, `skillful = true` (spike A1: `false` empties the skill list, AGT-30) and `task.maxRecursionDepth = 1` (spike A2: subagents never get `task`, AGT-31). The pinned values MUST be applied last.
- **AGT-23** Changes to omp settings MUST apply to runs that start afterwards, without an engine restart. Runs already in progress keep their configuration.

### 2.6 Skills and agents

- **AGT-24** The system MUST ship no skills or task agents. The admin's skills and agents live in the orchestrator (`<state>/omp`). Each worker downloads a copy at start and loads it as the session's only extension root. Skills are at `skills/<name>/SKILL.md` and agents at `agents/<name>.md`. The worker MUST pass the skills to omp explicitly, so that omp's own skill discovery (agent dir, `$HOME`, working directory) is off (spike A1). The session's working directory MUST be a run directory outside the scratch directory, with no `.omp` in it or above it, so that files the agent writes cannot add skills or agents (spikes A1, A2).
- **AGT-25** An agent is uploaded as a single `.md` file of at most 256 KiB. A skill is uploaded either as its `SKILL.md` alone or as a `.zip` of the skill folder (at most 5 MiB unpacked, `SKILL.md` at the top, no symlinks, no paths outside the folder). The YAML frontmatter MUST have a `name` matching `^[a-z0-9][a-z0-9-]{0,63}$` and a non-empty `description`. The agent names `main` and `sub` are reserved. The frontmatter name, not the file name, decides where the file is stored. Writes MUST be atomic, and uploading an existing name replaces it. Removing a skill deletes its folder. An agent's frontmatter MUST also satisfy these rules:
  - `tools` is required, and MUST be a non-empty subset of the subagent allowlist, which is `web_search` only;
  - `task` in `tools`, and any `spawns` value, MUST be refused;
  - the keys `advisor` and `prewalk` MUST be refused, because they attach another model loop with its own tools to the subagent (spike A2).

  A refused upload MUST store nothing and return the reason. The listing MUST show broken entries with the reason.
- **AGT-26** Skill and agent changes MUST apply to sessions that start afterwards.
- **AGT-30** Skills in `/ask`:
  - `read_file` and `list_files` MUST accept `skill://<name>` (the skill's folder; for `read_file`, its `SKILL.md`) and `skill://<name>/<relative path>`. This is the only URL scheme they accept (AGT-28).
  - These paths MUST resolve inside the run's copy of the skills with the AGT-28 confinement rules, and are read-only.
  - `write_file` MUST refuse `skill://` paths with "skills are read-only".
  - `read_file` MUST declare itself to omp as a tool that reads skill URIs, so that omp lists the installed skills in the system prompt.
- **AGT-31** Task agents in `/ask`:
  - `task` MUST spawn only the admin's agents (AGT-24). omp's bundled agents, agents found anywhere else, and user-tagged model agents (`^provider/model`) MUST NOT be spawnable. The session MUST name the valid agents as its only spawnable agents (omp's `spawns` allowlist, spike A2).
  - A subagent MUST get only the tools its frontmatter names, within the allowlist (AGT-25), plus only what omp itself needs to return the subagent's result.
  - The worker MUST check every downloaded agent against AGT-25 and delete invalid ones (and files not named `<frontmatter name>.md`) before the session starts, logging `agent skipped` with the name and reason. Deleting, not only leaving out, matters because omp keeps the first file of a name (spike A2).
  - Subagents MUST NOT spawn subagents.
- **AGT-32** Subagent usage MUST count toward the turn's usage (OBS-05) and its cost limit; the cost limit MUST also be checked while a subagent runs, from its live usage (spike A2). Subagent time counts toward the turn's time limit (AGT-14). Aborting the turn MUST abort its subagents.

### 2.7 Loadout

- **AGT-27** After a session is created, the system MUST capture its loadout:
  - active tools;
  - skills;
  - task agents (only when `task` is active, minus `task.disabledAgents`).

  The latest loadout MUST persist across restarts.

### 2.8 Ask scratch tools

- **AGT-28** Scratch file tools MUST confine every path to the thread's scratch directory. They MUST refuse:
  - NUL bytes;
  - URL schemes;
  - absolute and `~` paths;
  - `..` escapes;
  - symlinked ancestors or targets.
- **AGT-29** `read_file`:
  - pages 2000 lines by default, at most 10 000, and at most 256 KiB per call;
  - shows images (png, jpg, gif, webp, up to 5 MiB);
  - converts PDF, DOCX, PPTX, XLSX and EPUB to text or Markdown;
  - refuses binary files (a NUL in the first 8 KiB).

  `write_file` accepts text up to 10 MiB and creates parent directories. `list_files` stops at 500 entries.

## 3. Discord

### 3.1 Bot and access control

- **DSC-01** The bot MUST use the intents Guilds, GuildMessages and MessageContent. At every ready event it MUST replace the guild's commands with exactly two top-level commands, `/ask` and `/stop`.
- **DSC-02** Only allowed members (§1) MAY post follow-ups in, steer and `/stop` ask threads started by other users. Settings MUST require at least one allowed user or role.
- **DSC-03** `/ask` MUST work only directly in a channel listed in `discord.askChannelIds`, not in its threads, and there it is available to anyone. An ask channel MUST NOT be listed twice.
- **DSC-04** A refused command MUST get an ephemeral reply with the reason and MUST be logged as `command refused` with the user, channel and reason. The reasons are `ask-in-thread`, `ask-elsewhere` and `ask-unconfigured` for `/ask`, and `not-an-ask-thread` and `not-allowed` for `/stop`.
- **DSC-06** In ask-only threads, only the thread starter or an allowed member MAY post follow-ups, attach files or steer. Messages from anyone else are ignored silently. A non-allowed user MUST have at most one live run across all threads. The count MUST come from the runs table, so it survives an orchestrator restart.
- **DSC-07** Every bot message MUST disable all mentions.
- **DSC-08** The bot MUST ignore bot authors, non-guild messages and messages outside threads. An unhandled interaction error MUST be logged and answered ephemerally with `Error: <message>`.

### 3.2 Commands

| Command | Behaviour |
|---|---|
| `/ask prompt [file file2 file3]` | Ask-only chat (§4). |
| `/stop` | In an ask thread, by the thread starter or an allowed member: stop the live run (CHAT-05), or reply "Nothing is running." Anywhere else, reply "Use inside an ask thread". |

- **DSC-39** `/stop` MUST behave as in the table above. In an ask thread, a user who is neither the thread starter nor an allowed member MUST be refused with the reason `not-allowed`; anywhere else the reason is `not-an-ask-thread` (DSC-04). A `/stop` while the thread has no pending or active run MUST change nothing.

### 3.3 Live progress

- **DSC-10** Every ask turn MUST keep one live status message:
  - the icon and title;
  - the state: working 🛠️, finished ✅, failed ❌, cancelled ⏹️;
  - the elapsed time and the cost;
  - the current activity (tool and intent, or "Waiting for a worker…", architecture RUN-03).
- **DSC-11** Activity edits MUST be throttled to at most one per 5 s, with a heartbeat every 15 s. State changes MUST be shown immediately. Edits MUST be serialised, and edit failures MUST NOT fail the run. All writes go through the queue in DSC-32. The message ids and latest state survive an orchestrator restart (architecture RUN-14).
- **DSC-14** Messages MUST fit Discord's 2000-character limit. Long text MUST be split at paragraph boundaries, and hard-split when a single paragraph is too long.
- **DSC-15** Ask threads MUST show 🛠️ on their top message while working, and ✅, ❌, ⚠️ (limit) or ⏹️ when the run ends.

### 3.4 Steering and the outbound queue

- **DSC-24** Steering messages MUST be acknowledged with 👀 once the agent has received them, and with ⏳ while they are queued for a run that cannot take them yet (architecture RUN-15).
- **DSC-32** All Discord writes MUST go through one outbound queue in the orchestrator, shared by every run:
  - **Coalescing:** at most one pending edit per message. A newer edit replaces an unsent one, so the latest state wins.
  - **Priority:**
    1. new messages, delivery reactions, results and failures;
    2. state-change edits;
    3. activity and heartbeat edits.
  - **Rate limits:** the queue honours Discord's rate-limit responses (retry-after), per route and globally. While a channel is rate-limited, its heartbeat edits are skipped, not queued.
  - **Visibility:** the status page shows the queue length and the age of the oldest queued write.

### 3.5 Agent name

- **DSC-29** The admin MUST be able to set `agent.name` (1–32 characters, Discord's nickname limit; default `AskBot`). At engine start and after every settings save, the bot MUST set its server nickname in the configured guild to `agent.name`. The bot needs the Change Nickname permission for this. Without it, the system MUST log a warning and carry on with the current name; the warning MUST also appear on the status page. The bot's global username and avatar are set in the Discord Developer Portal and are not managed by the system.
- **DSC-30** All text that names the system MUST use `agent.name`. This covers Discord messages and agent prompts. A rename MUST take effect for text written after the save. Text already posted is not edited.
- **DSC-31** These identifiers MUST NOT change when the agent is renamed:
  - the slash command names (`/ask`, `/stop`);
  - environment variables, data paths and the cookie name.

## 4. Ask-only chat (`/ask`)

- **CHAT-07** `/ask` MUST start a one-day thread in the ask channel and run the `ask` profile on a worker. Its scratch directory `<state>/scratch/<threadId>/{inputs,outputs}` lives in the orchestrator; the worker gets a copy of the inputs and sends back new or changed outputs (architecture RUN-19). It is a general assistant with web search and the admin's skills and task agents (AGT-30, AGT-31), and it uses `models.ask`. Its limits are CHAT-04 and AGT-14.
- **CHAT-03** A reply in the thread MUST steer the live run, or resume the same omp session in a new run on a new worker.
- **CHAT-04** Admission MUST be refused when:
  - the thread already has a run starting;
  - `limits.maxChatSessions` (default 2) ask runs are already active; a new `/ask` is then refused before any thread is created;
  - DSC-06 applies.
- **CHAT-05** A stop MUST post "Stopped." When a limit is hit, the system MUST post which limit stopped the run and that sending another message continues it. Failures MUST post the error and invite a retry.
- **CHAT-06** Every 60 s, ask chats idle longer than `limits.chatIdleMinutes` (default 30) with no active run MUST have their scratch directory removed. The session is kept so that the conversation can resume.
- **CHAT-08** Attachments in:
  - up to 3 on the command and up to 10 per message;
  - at most 25 MiB each, checked before and during download;
  - saved under a sanitised, collision-free name in `inputs/`.

  Rejected files MUST get a ⚠️ reply, and the run MUST continue with the remaining files.
- **CHAT-09** Sanitised file names MUST:
  - strip directory parts and control characters;
  - replace `..` and any character outside `[A-Za-z0-9._ -]` with `_`;
  - drop leading dots and spaces;
  - be at most 100 characters, keeping an extension of at most 20 characters;
  - fall back to `file`.
- **CHAT-10** Output:
  - the answer MUST be attached as `answer.md` with a short message, and truncated with a note if it exceeds the upload limit; the cut MUST fall on a UTF-8 character boundary, never inside a multi-byte sequence;
  - new or changed regular files in `outputs/` (symlinks excluded) MUST be attached, at most 10 files and 10 MiB per message;
  - files that are too large MUST be listed by name;
  - produced files MUST be delivered even when the run stopped or failed;
  - only text formats can be produced.
- **CHAT-11** After `chatIdleMinutes`, the scratch directory MUST be deleted. The next follow-up MUST tell the agent that earlier files are gone. Deletion MUST refuse paths outside the scratch root.

## 5. Web UI

### 5.1 Setup, login, account

- **WEB-01** There MUST be no configuration files. All settings are entered in the web UI.
- **WEB-02** On first start the system MUST log a one-time setup token (18 random bytes, base64url). `/setup` MUST exist only until the admin account is created. It MUST require the token (compared in constant time) and accept a username of 1–64 characters and a password of at least 12 characters, entered twice.
- **WEB-03** Login MUST return the same failure for an unknown username and a wrong password, and MUST always pay the scrypt cost. After 5 failures in 15 minutes, an IP MUST be blocked for 15 minutes (HTTP 429 with the remaining time). Checks from one IP MUST run one at a time (a parallel attempt gets 429 with `Retry-After: 1`), so parallel posts can't get around the count. The IP is the connection's peer; when the peer is in `ASKBOT_WEB_TRUSTED_PROXIES`, it is the right-most `X-Forwarded-For` entry that is not a trusted proxy. The orchestrator's `/login` and `/credentials` additionally allow 50 failed password checks per 15 minutes in total, one at a time, because every caller there holds the same web token (architecture §6).
- **WEB-04** Changing credentials MUST require the current password and MUST end all other sessions.

### 5.2 Sessions and request security

- **WEB-05** The session cookie `askbot_session` MUST:
  - hold 32 random bytes;
  - be `HttpOnly`, `SameSite=Strict` and `Path=/`;
  - be `Secure` when the request is HTTPS (directly or through the first `X-Forwarded-Proto` value).

  Sessions MUST expire after 12 h idle and are held only in memory.
- **WEB-06** Every response MUST send:
  - `Content-Security-Policy: default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'`;
  - `X-Content-Type-Options: nosniff`;
  - `Referrer-Policy: same-origin`;
  - `Cache-Control: no-store`.
- **WEB-07** A POST whose `Origin` (or `Referer`) host is not the request host, or that has neither header, MUST be rejected with HTTP 403.
- **WEB-09** An unauthenticated HTML request MUST redirect to `/login`, or to `/setup` before setup. An unauthenticated JSON request MUST get HTTP 401 `{"error":"unauthorized"}`. Unhandled errors MUST return HTTP 500 without details.

### 5.3 Pages

| Route | Requirement |
|---|---|
| `/` | Home: cards for every page, engine phase, the count of model accounts, a version table (app, commit, build date, omp and libraries, Bun, OS/arch, container), and a getting-started checklist: bot token, guild, allowed users, an ask channel, and a model sign-in or provider key. |
| `/status`, `/status.json` | Landing page after login: engine phase and uptime, Discord state, the Discord write queue (length and oldest age, DSC-32), pending runs and their age, concurrency limits with worker capacity and warnings (architecture RUN-10 to RUN-12), live workers (id, pod or container, address, run, phase, omp version), runs in progress (worker, elapsed, last tool, live cost and tokens, loadout), active ask threads, usage (§6), and the latest loadout. Window `24h`, `7d` (default), `30d` or `all`. Live sections refresh. |
| `/logs` | Live tail of agent transcripts (last 500 entries, at most 2000 rows), filterable by run, entry type and text, with pause and follow. Server-sent events resume through `Last-Event-ID`, with a ping every 15 s. Lists the agent and orchestrator log files for download (only listed segment names are served). Web proxies both the stream and the downloads from the orchestrator. |
| `/admin` | Settings (§9) and Account. Secrets are write-only: the page shows only whether each one is set, and a blank field keeps the stored value. Saving validates, encrypts, asks the orchestrator to apply the settings (ENG-02), and reports the resulting phase or startup error. Every field has hover help with an example and the schema default. Ask-only channels are chosen from a dropdown (§5.4). |
| `/admin/omp` | omp setting overrides with a searchable reference (AGT-20, AGT-23). Credential-type settings are write-only. Shows the omp version and the update panel (WEB-33). |
| `/admin/skills` | Upload and remove skills and agents (AGT-25). |
| `/admin/models` | Provider sign-in and available model ids (§7.3). |
| `/healthz` | Unauthenticated web health. Returns 200 while the web UI serves, whatever the orchestrator's state, so the web pod is never restarted because of the orchestrator. Body: `{status, version, orchestrator}`, where `orchestrator` is `{reachable, phase, limits}` relayed from the orchestrator's `/readyz` (architecture §4.5). Never includes error text. |

- **WEB-10** Every logged-in page MUST have a ☰ menu built from the same list as the home cards. Esc or a click outside closes it.
- **WEB-11** Every page MUST offer a theme of Auto (the OS setting), Light or Dark, stored per browser and applied before the first paint so the wrong theme never flashes.
- **WEB-33** `/admin/omp` MUST show the omp update state (§11):
  - the running omp version, the latest version found, the last check time and any check error, and a **Check now** button;
  - when a newer version is on offer and no install is running, an **Approve update** button that starts the UPD-03 install;
  - the current or last attempt: version, by whom, outcome, error and output tail;
  - whether `omp.autoUpdate` is on.

  The page MUST refresh while an install runs.

### 5.4 Choosing Discord channels

- **WEB-20** Once a Discord bot token and `discord.guildId` are stored, the **Add ask-only channel** control (`discord.askChannelIds`) MUST be a dropdown instead of a typed ID.
  - The orchestrator builds the list with the bot token over Discord's REST API: the guild's channels, the guild's roles and the bot's member record. It works whether or not the engine is running.
  - Only text channels are listed: no voice, forum, announcement or category channels, and no threads.
  - Entries are shown as `#name`, grouped under their category in Discord's order, and filterable by typing when there are more than 20.
- **WEB-21** For each channel, the dropdown MUST work out the bot's effective permissions from the guild's roles and the channel's permission overwrites. Ask-only channels need View Channel, Send Messages, Create Public Threads, Send Messages in Threads, Read Message History, Attach Files and Add Reactions.
  - A channel the bot cannot view MUST be shown disabled, with "the bot can't see this channel; add it to the channel".
  - A channel the bot can view but where it lacks other permissions MUST be selectable, with a warning that names the missing permissions.
- **WEB-22** A channel MUST appear at most once in `discord.askChannelIds`. Channels already in the list are not offered again.
- **WEB-23** Before the bot token and guild id are stored, the ask-only channel control MUST say "Save the Discord bot token and guild id to choose channels" instead of a dropdown.
  - If listing fails, the control MUST show the error inline with a **Retry** button, and the rest of the page MUST stay usable. Errors include an invalid token, Discord being unreachable, and the bot not being a member of the guild. For the last one, the message MUST include the bot's invite link. That link grants the WEB-21 channel permissions plus Change Nickname (DSC-29).
  - The list MUST be cached for at most 60 s, and a **Refresh** button MUST reload it, so that new channels and permission changes appear without a restart.
- **WEB-24** On save, the orchestrator MUST check every configured ask-only channel against the live guild. A channel that no longer exists, is not a text channel, or that the bot cannot view MUST make the save fail with a message naming the field and the channel. Missing permissions other than View Channel MUST NOT block the save; they are shown as a warning with the result of the save. A configured channel that has disappeared MUST be shown as "unknown channel <id>" so that it can be removed. When the guild cannot be listed at save time (wrong bot token, bot not in the guild, Discord unreachable), the save MUST still succeed, with the warning "The Discord channels were not checked: <reason>", so that a wrong token can be corrected.

## 6. Observability

- **OBS-01** Every component MUST expose health as defined in architecture §4.5:
  - the orchestrator: `/livez`, `/readyz` and `/healthz`;
  - web: `/healthz`;
  - workers and the launcher: `askbot health`.

  Health responses MUST include the version. The orchestrator's responses MUST also include its concurrency limits and worker capacity. Docker/Podman MUST probe every 30 s (timeout 5 s, start period 30 s, 3 retries). Kubernetes uses the same endpoints as liveness and readiness probes.
- **OBS-02** Every component MUST log one JSON object per line (`ts`, `level`, `msg`, `component` and fields) to stdout. The orchestrator MUST also write its log to a rolling file in `<state>/logs/orchestrator/`. Web and worker logs are read with `podman logs` or `kubectl logs`. Workers MUST forward agent transcripts to the orchestrator (OBS-03).
- **OBS-03** Agent transcripts MUST be appended as JSONL to `<state>/logs/agent/` with these events. Workers apply the truncation limits before sending (architecture RUN-16):

  | Event | Truncated at |
  |---|---|
  | `prompt` | 64 KiB |
  | `steer` | 16 KiB |
  | `assistant` | 64 KiB |
  | `tool_start` | 4 KiB (arguments) |
  | `tool_end` | 8 KiB (output) |
  | `run_end` | 4 KiB (error) |

  Each entry carries the run (thread id, channel id, Discord user id, kind `ask`), a sequence number and a timestamp. Truncated text MUST end with a marker giving the number of characters dropped. The last 2000 entries MUST be kept in memory and refilled at start from the newest 4 MiB.
- **OBS-04** The total log size MUST be a setting (`logs.maxGiB`, default 5 GiB, minimum 0.1 GiB), split 90% to agent transcripts and 10% to the process log.
  - Segments rotate at `min(64 MiB, share/20)`.
  - The oldest segments are deleted immediately, including when the setting is lowered.
  - `ASKBOT_AGENT_LOG_MAX_BYTES` (an integer of at least 1 MiB) overrides the setting.
  - While the settings are locked, the size last applied is used.
  - Appending a log entry MUST never throw.
- **OBS-05** Usage MUST be recorded for every agent run, whatever its outcome: cost, tokens in and out, cache read and cache write, including the usage of the run's task subagents (AGT-32). A resumed session's earlier history MUST NOT be counted again.
- **OBS-06** Usage reports MUST include:
  - totals for the window, by ask channel and by Discord user, sorted by cost;
  - run counts (finished, failed, stopped, stopped by a limit) and the average duration;
  - daily cost for the last 14 UTC days, including days with zero cost.

## 7. Security

### 7.1 Credentials

- **SEC-01** Agents MUST NOT hold Discord credentials. All Discord posts MUST be made by the orchestrator.
- **SEC-02** Discord message text and attachments MUST be treated as untrusted input to the agent.

### 7.2 Vault

- **SEC-03** These MUST be stored encrypted in SQLite: settings, secrets and the omp configuration. Each blob is sealed with AES-256-GCM (12-byte IV) under a random 32-byte data key, with a distinct additional-data label per blob.
- **SEC-04** The data key MUST be stored only in wrapped form:
  - under a key derived from the admin password with scrypt (N=2^15, r=8, p=1, 16-byte salt, password NFC-normalised);
  - optionally, under a key derived with HKDF-SHA256 from a master key file of at least 32 characters.
- **SEC-05** With a master key, the service MUST unlock and start without a person. Without one, it MUST wait in phase `locked`, doing no Discord work, until an admin logs in. An admin login MUST enrol a new or rotated master key.

### 7.3 Model accounts

- **SEC-12** `/admin/models` MUST run omp's own sign-in for any omp provider. Featured providers come first: `anthropic`, `xai-oauth`, `google-gemini-cli`, `google-antigravity`, `openai-codex`, `openai-codex-device` and `github-copilot`.
  - Browser flows accept the pasted redirect URL or code.
  - Device flows show the code and finish by polling.
  - A sign-in left unattended MUST be aborted after 15 minutes.
  - Anthropic grants MUST show their re-login deadline.
- **SEC-13** Model sign-ins MUST be stored only by the orchestrator and refreshed only by the orchestrator (architecture CRED-01 to CRED-03, CRED-05). They MUST be usable by the next run without a restart.

## 8. Engine lifecycle

- **ENG-01** The engine phases MUST be `setup`, `locked`, `unconfigured`, `starting`, `running`, `stopping` and `error`. The web UI MUST serve in every phase.
- **ENG-02** Applying settings MUST stop the engine's services (Discord, dispatch, the idle sweep) and then choose the phase:
  - `setup` when no admin exists;
  - `locked` when the vault is locked;
  - `error` when the settings cannot be read;
  - `unconfigured` when no settings have been saved, or when `discord.askChannelIds` is empty, with the message "Add an ask-only channel in Settings (Discord) to start the engine.";
  - otherwise `starting`, then `running` or `error`, keeping the error message.

  Applying and stopping MUST be serialised. Runs on workers MUST NOT be aborted. Their worker connections are held by the internal API, not the engine, and stay open. Events that arrive while the engine is not `running` MUST be queued and applied once it is.
- **ENG-03** Engine start MUST:
  1. create the state directories;
  2. recover runs (architecture RUN-07);
  3. start the chat idle sweep and resume dispatch.

  A Discord login failure MUST end in `error`.
- **ENG-04** Graceful shutdown of the orchestrator on SIGTERM MUST stop, in order: update checks, the internal API (sockets close with 1001), the engine (idle sweep, dispatch, then Discord) and the database. Runs on workers MUST keep going (RUN-09). It MUST finish within about 10 s. From the start of shutdown the engine phase MUST be `stopping` and no apply MUST start the engine again; no phase is reported once the process has exited.
- **ENG-05** Ask session files MUST be kept, so that a thread can resume (CHAT-03). Any deletion of session files MUST touch only paths inside `<state>/sessions`.

## 9. Configuration reference

The settings are validated as a whole on save. Errors read `Invalid config: <path>: <message>`.

| Setting | Type / rule | Default |
|---|---|---|
| `discord.guildId` | required string | none |
| `discord.allowedUserIds`, `allowedRoleIds` | string lists; at least one non-empty | `[]` |
| `discord.askChannelIds` | string list chosen from the channel dropdown (§5.4); no duplicates. Not needed to save, so a fresh install can store the bot token first and then choose channels; the engine stays `unconfigured` until one is set (ENG-02). | `[]` |
| `agent.name` | 1–32 characters; Discord nickname and the name used in text | `AskBot` |
| `models.ask` | optional model id, used by `/ask` | omp default |
| `models.thinking` | `auto`, `inherit`, `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` | `high` |
| `limits.maxChatSessions` | positive integer; ask runs active at once (CHAT-04) | 2 |
| `limits.maxCostUsdPerTurn` | positive number; per ask turn, subagents included (AGT-14) | 15 |
| `limits.chatIdleMinutes` | positive number | 30 |
| `workers.maxConcurrentRuns` | optional positive integer. Never rejected on save; health reports a warning when it exceeds worker capacity (RUN-10). | unset (= worker capacity) |
| `workers.reattachGraceSeconds` | positive integer | 90 |
| `logs.maxGiB` | ≥ 0.1 | 5 |
| `omp.autoUpdate` | boolean; install a newer omp for workers without an approval (UPD-02, UPD-03) | `false` |
| `secrets.discordToken` | required, write-only | none |
| `secrets.providerKeys` | map of provider id to key, write-only | `{}` |

| Environment variable | Purpose | Default |
|---|---|---|
| `ASKBOT_STATE_DIR` | state volume root (`<state>`), orchestrator only | `./state` (image: `/state`) |
| `ASKBOT_OMP_DIR` | skills and agents root, orchestrator only | `<state>/omp` |
| `ASKBOT_WEB_HOST` / `ASKBOT_WEB_PORT` | web listener | `127.0.0.1` / `8080` (image host `0.0.0.0`) |
| `ASKBOT_WEB_TRUSTED_PROXIES` | web only: comma-separated CIDRs (or addresses) of reverse proxies in front of web. A request whose peer is in the list is attributed to the right-most `X-Forwarded-For` entry that is not, for the login throttle (WEB-03). Without it `X-Forwarded-For` is ignored. | none |
| `ASKBOT_MASTER_KEY_FILE` | path to the mounted master key file; orchestrator only; optional | none |
| `ASKBOT_INTERNAL_HOST` / `ASKBOT_INTERNAL_PORT` | orchestrator internal API listener | `0.0.0.0` / `8081` |
| `ASKBOT_WEB_API_TOKEN_FILE`, `ASKBOT_WORKER_TOKEN_FILE`, `ASKBOT_SCALE_TOKEN_FILE` | mounted internal tokens (SEC-14), each only in the components that use it | none |
| `ASKBOT_AGENT_LOG_MAX_BYTES` | log size override | unset |
| `ASKBOT_OMP_RUNTIME_DIR` | enables in-place omp updates (orchestrator installs, workers use) | set only in the image |
| `ASKBOT_ROLE` / command argument | `orchestrator`, `web`, `worker` or `launcher` | none |
| `ASKBOT_ORCHESTRATOR_URL` | internal API URL for web and workers | `http://orchestrator:8081` |
| `ASKBOT_WORKER_CLAIM_TIMEOUT` | how long a new worker waits for a run before exiting | `15s` |
| `ASKBOT_WORKER_ADDRESS_BINDING` | orchestrator only: one claim at a time per worker network address, and each worker id bound to the address it first connected from (architecture §6). Turn `off` only where workers share a source address (a service mesh that rewrites it). | `on` |
| `ASKBOT_WORKER_RUN_DIR` | worker: parent of the run-local root (status file, run-private auth store, omp's `HOME` and agent dir, `TMPDIR`; architecture §5). The launcher mounts a tmpfs there, Helm a memory `emptyDir`. | `$TMPDIR/askbot-worker` (image: `/run/askbot`) |
| `ASKBOT_WORKER_CAPACITY` | orchestrator and launcher: how many workers can run at once. Helm sets it to `worker.maxReplicas`; compose sets it on both services. | `4` (compose), `10` (Helm) |
| `ASKBOT_IMAGE` | launcher only: the AskBot image the stack runs, which workers are started from; compose sets it to the services' `image:` | required |
| `ASKBOT_WORKER_NETWORK` | launcher only: the network workers join (a fixed `name:` in compose: `<ASKBOT_NETWORK>-workers`, which only the orchestrator shares) | required |
| `ASKBOT_WORKER_SECRET` | launcher only: name of the Podman secret holding the worker token | `askbot_worker_token` |
| `ASKBOT_WORKER_MEMORY` / `ASKBOT_WORKER_DISK` | per-worker memory limit and scratch space limit (architecture STO-06); set by the launcher (Podman) or the chart (Helm) | `4g` / `2g` |
| `ASKBOT_WORKER_CPUS` | launcher only: CPU quota per worker container, in CPUs as `podman run --cpus` (0.01 to 1024, fractions allowed). Helm sets CPU through `worker.resources`. | `2` |
| `ASKBOT_PODMAN_SOCKET` | launcher only: rootless Podman API socket | `/run/podman/podman.sock` (mounted from `$XDG_RUNTIME_DIR/podman/podman.sock`, or `ASKBOT_HOST_PODMAN_SOCKET` in compose) |
| `ASKBOT_LAUNCHER_ALLOW_ROOTFUL` | launcher only: accept a rootful Podman socket (LCH-01); logs a warning at every start | unset |
| `ASKBOT_VERSION`, `ASKBOT_COMMIT`, `ASKBOT_BUILD_DATE` | build info on the home page | `package.json` version |

## 10. Persistence

- **DB-01** State MUST live in one SQLite database at `<state>/askbot.db`. It uses WAL, foreign keys on, and a 5 s busy timeout. The schema is created with `IF NOT EXISTS` and has no migration framework.
- **DB-02** Entities:
  - ask chats (thread, channel, owner);
  - agent runs (usage, with the ask channel and the Discord user);
  - runs (state, owner thread, worker id and address, lease token and expiry, loss count, omp version used, the earlier run it continues; architecture §4.1);
  - outgoing relay messages to workers that have not been acknowledged yet (architecture RUN-06);
  - a key-value store: vault, log cap, omp update state, the latest loadout, and per ask thread the Discord ids of the thread and its live status message with the latest progress snapshot (architecture RUN-14).

  Model sign-ins live in omp's own SQLite store `<state>/omp-agent/agent.db`, next to the main database (CRED-01). The packed omp runtime copies and their failed markers live in `<state>/omp-runtime/` (architecture §8).
- **DB-03** All persistent state MUST live in the orchestrator's **state** volume (`<state>`, RWO): the database, the model sign-in store, session files, ask scratch files, skills and agents, omp runtime copies, and the orchestrator and agent logs. Web has no volume. Workers keep nothing: their scratch copy and run-local storage are deleted with them (architecture §5, RUN-20). No volume is shared between components.

## 11. omp version and in-place updates (architecture §8)

- **UPD-01** An image build MUST install npm's latest omp. It MUST fall back to the version pinned in `package.json` when the latest version fails to install (10 min timeout) or fails to load the app's entry modules (2 min timeout). The build log MUST show which version was used and why. CI MUST test the pinned version.
- **UPD-02** The service MUST check the npm registry 60 s after start and every 6 h after that (10 s timeout). The result (latest version, check time, check error) MUST be stored and shown on `/admin/omp` (WEB-33); nothing is posted to Discord. Check errors MUST NOT throw. When `omp.autoUpdate` is on and a newer omp exists, the install MUST start at once, with no approval.
- **UPD-03** On **Approve update** by the logged-in admin on `/admin/omp`, or automatically (`omp.autoUpdate`), the orchestrator MUST install the newer omp for workers as described in architecture UPD-06.
  - Any failure MUST leave the current omp in place, and `/admin/omp` MUST show the error and the output tail with a fresh **Approve update** button.
  - A stale approval MUST be refused, and so MUST a second concurrent approval.
  - The attempt MUST record the admin username, or `auto-update` for an automatic install.
  - A version whose last attempt failed (an install failure, a canary failure, or an orchestrator restart during the install) MUST NOT be installed automatically again; a newer version or an approval can try.

  No component restarts. Turning `omp.autoUpdate` off MUST NOT cancel a running install.
- **UPD-04** Workers MUST choose the omp per run, falling back to the image's omp, as described in architecture UPD-07 and UPD-08. The orchestrator MUST drop copies from another image (UPD-09).
- **UPD-05** Updates MUST be refused outside the container image (no `ASKBOT_OMP_RUNTIME_DIR`). The orchestrator keeps the image's omp, and web has none (UPD-10).

## 12. Packaging and deployment

- **OPS-01** AskBot MUST ship as one container image, `askbot`, based on `oven/bun` (Debian), with the role chosen by the command (`askbot orchestrator`, `web`, `worker` or `launcher`). Every container MUST run as the unprivileged user `askbot` (uid/gid 10001), with no root entrypoint. There is no derived worker image.
- **OPS-02** The role entrypoints MUST follow architecture §7.1:
  - the web entrypoint, `askbot web`, starts the web server only;
  - a worker runs exactly one run and exits (architecture §2.3);
  - the orchestrator reads the master key from its mounted file.
- **OPS-03** A compose file MUST run the stack with `podman compose` under rootless Podman ≥ 4.6 (architecture §7.2):
  - three long-running services, `orchestrator`, `web` and `launcher`, with the launcher starting one worker container per run through the rootless Podman socket (architecture LCH-01 to LCH-04);
  - only web publishes a port: `127.0.0.1:8080`;
  - one named volume, `askbot-state`;
  - secrets mounted per service (files, plus the worker token as a Podman secret for workers; architecture §7.2);
  - `restart: unless-stopped` and a health check per service.

  Docker Engine is not supported for this stack, because the launcher refuses a rootful socket.
- **OPS-04** CI MUST:
  - run on every pull request, and on every push to `main` except pushes that change only Markdown or `wiki/`;
  - wait 30 s, with newer pushes cancelling older runs;
  - run `bun install --frozen-lockfile`, typecheck and tests.

  The version MUST be `<major>.<minor>.<run number>`. On `main`, CI MUST push `ghcr.io/<owner>/askbot:<version>` and `:latest` and tag `v<version>`. CI MUST also lint the Helm chart and render it with default values.
- **OPS-06** A `dry-run` script, `bun run dry-run --prompt <text> [--file <path>]… [--omp-dir <dir>] [--model <id>] [--thinking <level>]`, MUST run the `ask` profile locally, with no Discord:
  - it creates a temporary scratch directory and copies the given files into its `inputs/`;
  - `--omp-dir` supplies skills and agents (AGT-24);
  - it prints the answer JSON, the files produced in `outputs/` and the usage;
  - it removes the temporary directory when it ends, also on Ctrl-C.

  It uses the local omp sign-ins and provider keys, as a worker would use its run's copy.
- **OPS-07** A Helm chart, `deploy/helm/askbot`, MUST deploy the stack to Kubernetes (architecture §7.3):
  - a singleton orchestrator Deployment (`Recreate`) and a web Deployment;
  - a KEDA `ScaledJob` for workers, from 0 to `worker.maxReplicas` (default 10) pods, one run per pod, each pod deleted shortly after its run;
  - a single RWO PVC for the orchestrator state;
  - generated secrets, NetworkPolicies and an optional Ingress.
- **OPS-08** The Kubernetes prerequisites MUST be documented and checked by the chart where possible: Kubernetes ≥ 1.27 and KEDA ≥ 2.12, with KEDA ≥ 2.19 recommended, because older versions can start one extra worker pod near `maxReplicaCount` (AgentBot spike S5, `../AgentBot/wiki/spikes/S5.md`). The chart fails with a clear message when the `ScaledJob` CRD is missing. No ReadWriteMany storage is needed.
- **OPS-09** Workers MUST behave the same in both runtimes: one worker per run, started by the launcher (Podman) or KEDA (Kubernetes), deleted after the run.

## 13. Resource requirements

- **NFR-01** The documented memory budget is (measured in phase 9, implementation.md §4):
  - orchestrator: about 270 MB (`podman stats`, idle and during a run);
  - web: about 35 MB;
  - launcher: about 20 MB;
  - per concurrent agent run: about 600 MB: the worker supervisor about 190 MB (`podman stats`) plus the agent host about 420 MB (peak RSS with a real model and `web_search`, measured on macOS arm64; Linux is usually lower). Task subagents run inside the agent host.

  For Podman hosts, 4 GiB is the minimum and 8 GiB is recommended. Concurrency MUST be tunable down for small hosts (`maxChatSessions`, `ASKBOT_WORKER_CAPACITY`).
- **NFR-02** Each worker MUST have its own memory limit (default 4 GiB, no swap) and scratch space limit (default 2 GiB, architecture STO-06), in both runtimes, so that an out-of-memory kill or a full disk affects only that run and is reported for that run only (AGT-19, STO-06). The worker enforces the scratch limit by measuring its scratch copy periodically; under Podman this is a soft limit and the host disk is the hard ceiling, because rootless Podman cannot enforce a per-container disk limit (AgentBot spike S6, `../AgentBot/wiki/spikes/S6.md`). Under Kubernetes, `emptyDir.sizeLimit` also enforces it. Detection of OOM kills relies on cgroup v2.
- **NFR-06** Every run pays for a fresh worker start and the download of its skills, session and scratch inputs before the agent starts. That time MUST NOT count toward the run's time limit (architecture RUN-03), and the status page MUST show it per run.

## 14. Reliability summary

- **NFR-03** A restart of any component at any point MUST NOT lose or duplicate externally visible work. This is covered by UPD-03, UPD-04 and architecture RUN-04 to RUN-07 and RUN-09.
- **NFR-04** A failure in one agent run, one worker or one Discord edit MUST NOT stop the orchestrator or other runs. Restarting the web UI MUST NOT affect Discord or runs.
- **NFR-05** A transition triggered by a user (update approval, `/stop`) MUST be idempotent against double clicks and stale requests.

## 15. Explicitly out of scope

- GitHub, repositories, git and code changes.
- Shell or unconfined file access for the agent.
- MCP servers.
- A VS Code or other file-based configuration editor.
- The agent asking the user questions.
- Shipping built-in skills or agents.
- Producing binary outputs.
- Discord DMs.

## 16. Open questions

None. Spikes A1 and A2 ([implementation.md](implementation.md) §3) both passed, with no fallback ([spikes/A1.md](spikes/A1.md), [spikes/A2.md](spikes/A2.md)). Their conditions are written into AGT-20, AGT-24, AGT-25, AGT-31 and AGT-32.

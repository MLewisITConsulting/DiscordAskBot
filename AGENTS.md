# AskBot agent guidance

## Docs
- `wiki/requirements.md` — what the system must do (stable requirement IDs).
- `wiki/architecture.md` — components, run protocol, storage, deployment.
- `wiki/implementation.md` — phased plan; each phase lists the requirement IDs it delivers.
- `wiki/spikes/` — phase 0 spike notes (A1, A2); a spike's outcome overrides the plan where it says so.

## Porting
- AgentBot (`../AgentBot`, commit `1830870`) is the reference implementation. Modules were copied as mapped in implementation.md §2; change them, don't rewrite what already works.
- Drop what AskBot withdraws (architecture §10): GitHub, git, checkouts, jobs, plans, drafts, watches, `/work`, the to-do list, agent questions (`ui`), `create_issue`, MCP, the VS Code config editor.
- Renames are done: `agentbot` → `askbot`, `AGENTBOT_*` → `ASKBOT_*`.

## Code
- Bun + TypeScript strict. Tabs. One JSON log line per event via `src/shared/log.ts`.
- Layout follows implementation.md §2: `src/shared`, `src/orchestrator/*`, `src/web`, `src/worker`, `src/launcher`.
- Tests live in `test/unit`, `test/integration`, `test/e2e`. Tests are ported with their modules; delete tests that pin AgentBot-only wording or behaviour AskBot drops.
- `bun run typecheck` and `bun test` must pass before a change is done.

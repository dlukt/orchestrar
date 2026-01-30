# orchestrar

Orchestrates OpenCode milestones based on PRD.md, SPEC.md, and PLAN.md.

## Requirements

- Node.js 18+
- An OpenCode-compatible config with a `review-uncommited` command
- A repo containing PRD.md, SPEC.md, and PLAN.md in the root or `docs/`

## Install

```
npm install -g orchestrar
```

## Usage

Run from the repo root:

```
orchestrar
```

## Behavior

- Uses `github-copilot/gpt-5.2-codex` for work and review instances.
- Uses `github-copilot/gpt-5-mini` for the commit/push instance.
- Loops until all unchecked tasks in PLAN.md are marked.

## Configuration

Optional environment variables:

- `ORCHESTRATOR_REVIEW_COMMAND` (default: `review-uncommited`)
- `ORCHESTRATOR_REVIEW_ARGUMENTS` (default: empty)
- `ORCHESTRATOR_REVIEW_TIMEOUT_MS` (default: 3600000)
- `ORCHESTRATOR_SESSION_TIMEOUT_MS` (default: 7200000)
- `ORCHESTRATOR_STATUS_POLL_INTERVAL_MS` (default: 2000)
- `ORCHESTRATOR_MAX_REVIEW_ITERATIONS` (default: 20)

# Thegood Stock — Agent Team

This directory holds Claude Code subagents. They are invoked by the main Claude Code orchestrator based on their `description` field. The PM (Cowork session run by user `Pex`) sits above all of them and routes work.

## Roster

| Agent | Role | Primary skill | Layer |
|---|---|---|---|
| `business-analyst` | Spec & plan writer | `/using-superpowers` | Analysis |
| `ui-ux-designer` | Screen & flow design | `/frontend-design` | Design |
| `frontend-developer` | HTML/JS/CSS impl | (none mandated) | Frontend |
| `backend-developer` | SQL, RLS, Edge Functions | (none mandated) | Backend |
| `fullstack-developer` | Small cross-cutting changes | (none mandated) | FE+BE |
| `qa-engineer` | Test design & execution | `/buddhist-method` | QA |
| `devops-engineer` | Deploy, monitor, rollback | `/debug-root-cause` | Ops |
| `security-engineer` | Auth/RLS/secret/PDPA review | `/debug-root-cause` (triage) | Security |

## Reporting hierarchy

```
                Project Manager (Cowork — user Pex)
                            │
        ┌──────────┬────────┼────────────────┬────────────┐
        │          │        │                │            │
  business-   ui-ux-   frontend-/      qa-engineer    devops- &
  analyst    designer   backend-/                     security-
                       fullstack-                     engineer
                       developer
```

## Routing rules (for PM and orchestrator)

- New feature → `business-analyst` (spec) → `ui-ux-designer` (design) → `frontend-developer` + `backend-developer` (impl) → `qa-engineer` (test) → `devops-engineer` (deploy) → `qa-engineer` (smoke) → PM signs off.
- Bug → `qa-engineer` reproduces → routed to FE/BE/Full-stack → fix → `qa-engineer` regression → `devops-engineer` deploys.
- Security finding → `security-engineer` triages → routed appropriately, then re-audited.
- Cross-cutting tiny change → `fullstack-developer` (only if PM explicitly chooses).
- Do NOT invoke `fullstack-developer` concurrently with `frontend-developer` or `backend-developer` on the same task.

## Project rules every agent inherits

1. **no magic** — never invent values, behavior, or capabilities; cite or ask.
2. **verify before done** — concrete evidence required (test output, curl, query result), not self-assertion.
3. **dissent** — push back with reasoning before complying with anything that looks wrong.
4. **scope drift** — flag and refuse silent enlargement; raise it to PM.
5. **explicit assumptions** — every assumption goes in writing in the artifact.
6. **tell me all you do** — list every file touched and tool called.

## Skill availability note

The skills referenced (`/using-superpowers`, `/frontend-design`, `/buddhist-method`, `/debug-root-cause`) live in Claude Code's plugin/skill system, not in this repo. If an agent reports the skill is not installed, the PM should install it or approve a fallback.

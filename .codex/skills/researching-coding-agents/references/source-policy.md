# Source Policy

Use this file to choose what to research. The goal is decision support, not a complete market survey.

## Research Tiers

### Quick Research

Use quick research unless the task says otherwise.

Required set:
- Current repo: inspect implementation, docs, branch state, and chapter constraints.
- Pi: closest architectural reference for Forge Harness.
- Codex: reference for the local skill/plugin/subagent environment.
- One comparable product: the agent closest to the feature area.
- One contrast case: an agent that made a meaningfully different design choice.

### Deep Research

Use deep research when the feature is high-risk, source claims conflict, implementation details matter, or the user asks for "deep", "thorough", "full matrix", or similar.

Deep matrix:
- Claude Code
- OpenAI Codex
- Cursor
- Gemini CLI
- Aider
- Cline
- Roo
- Pi

## Source Priority

Prefer sources in this order:

1. Official docs and manuals.
2. Source repositories, especially implementation files linked from docs.
3. Release notes and changelogs.
4. Maintainer-authored engineering posts or RFCs.
5. Issues, discussions, and community posts only for pain points or user-reported failure modes.

Avoid relying on memory for current product behavior. If sources are missing, stale, or inaccessible, say so.

## Agent Profiles

| Agent | Use It For | Watch Out |
| --- | --- | --- |
| Pi | Minimal TypeScript terminal harness, extensions, skills, prompt templates, SDK, compaction, explicit sandbox boundaries. | It intentionally has no built-in sandbox; treat that as a design tradeoff, not a bug. |
| OpenAI Codex | Skills, plugins, AGENTS.md, subagents, sandbox/approval, app/CLI/IDE surfaces. | Codex is the host environment here; verify against current docs or current session tools. |
| Claude Code | Instructions, memory, hooks, skills, MCP, subagents, plan/execution patterns. | It may be more platform-rich than Forge Harness needs. |
| Gemini CLI | Terminal-first UX, Google Search grounding, GEMINI.md, MCP, checkpointing, headless JSON/stream output. | It is Google/Gemini-specific in model and auth assumptions. |
| Aider | Minimal pair-programming loop, repo map, git integration, lint/test repair, model-agnostic terminal work. | Less useful for multi-agent or platform extension design. |
| Cline | Plan/Act boundary, human approval, IDE/terminal surfaces, SDK, Kanban/worktree teams. | IDE-first UX can be too heavy for Forge Harness chapters. |
| Cursor | IDE-first agent UX, rules, skills, MCP, planning in editor workflows. | Docs may be JS-rendered; verify with official pages or source when possible. |
| Roo | Historical modes, orchestrator, model-agnostic VS Code workflow. | Treat as historical: docs/repo indicate shutdown/archive on May 15, 2026. |

## Feature Focus Rules

| Feature Area | Prioritize |
| --- | --- |
| skills/plugins/extensions | Codex, Pi, Claude Code, Cline |
| permissions/sandbox/security | Codex, Claude Code, Pi, Gemini CLI, Cline approval UX |
| context/memory/compaction | Pi, Claude Code, Codex, Gemini CLI, Aider repo map |
| planning/act mode | Cline, Cursor, Codex, Claude Code |
| minimal harness/tutorial architecture | Pi, Aider, Gemini CLI |
| multi-agent/scale | Codex subagents, Claude Code subagents, Cline Kanban, Roo historical modes |

## Baseline URLs

- Pi docs: https://pi.dev/docs/latest
- Pi repo: https://github.com/earendil-works/pi
- Codex docs: https://developers.openai.com/codex
- Claude Code docs: https://code.claude.com/docs
- Gemini CLI repo: https://github.com/google-gemini/gemini-cli
- Aider docs: https://aider.chat/docs/
- Aider repo: https://github.com/Aider-AI/aider
- Cline docs: https://docs.cline.bot/
- Cline repo: https://github.com/cline/cline
- Roo docs: https://roocodeinc.github.io/Roo-Code/
- Roo repo: https://github.com/RooCodeInc/Roo-Code
- Cursor docs: https://cursor.com/docs

## Decision Filter

For each researched mechanism, ask:

- What concrete pain point forced this mechanism to exist?
- Does Forge Harness have that pain point in the current chapter?
- Can the idea be reduced to a smaller tutorial mechanism?
- What should be explicitly rejected because it is platform-scale, product-specific, or premature?

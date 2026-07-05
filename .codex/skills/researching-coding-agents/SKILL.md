---
name: researching-coding-agents
description: Use when planning or designing coding-agent features, harness architecture, skills, memory, tools, permissions, compaction, subagents, or workflows; also use for prompts like "research other coding agents", "how do Claude Code/Codex/Pi do this", "调研别的 coding agent", "竞品怎么做", or "参考 Claude Code/Codex/Pi".
---

# Researching Coding Agents

## Overview

Use current evidence from other coding agents to shape feature design before proposing changes. Keep the research focused on the concrete pain point and translate findings into decisions for the current repo.

## Workflow

1. State the forced pain point in one sentence.
2. Inspect the current repo first. Identify the existing mechanism, chapter boundary, and constraints before researching outside systems.
3. Choose research depth:
   - Quick research by default.
   - Deep research only when the feature is high-risk, sources conflict, implementation details matter, or the user asks.
4. Read `references/source-policy.md` and select sources by feature area. Do not cover every agent equally unless deep research is required.
5. Use current primary sources. Prefer official docs, source repos, release notes, and directly linked implementation files over memory or secondary summaries.
6. Synthesize with `references/report-template.md`. Every external claim that influences design needs a source link.
7. Propose design options only after mapping findings to the current repo's constraints.

## Required Defaults

- Quick research source set: current repo + Pi + Codex + one comparable product + one contrast case.
- Treat Pi as the closest Forge Harness reference because it is a small TypeScript terminal harness.
- Treat Roo as historical only unless the user explicitly asks for legacy comparison.
- Prefer small mechanisms that fit tutorial order over platform-scale abstractions.
- If current sources are unavailable, say what could not be verified and keep the recommendation bounded.

## Output Rules

- Lead with the design implication, not a survey.
- Keep quick research compact: usually one source table and 3-5 design implications.
- Separate adopted ideas from rejected ideas.
- Do not copy an agent feature wholesale. Explain which local pain point justifies the mechanism here.
- Do not let external products override explicit repo instructions, tutorial scope, or chapter constraints.

## References

- `references/source-policy.md` - source tiers, agent differences, and feature-specific focus rules.
- `references/report-template.md` - compact research output format.
- `references/pressure-scenarios.md` - validation prompts for forward-testing this skill.

## Common Mistakes

| Mistake | Fix |
| --- | --- |
| Researching every tool equally | Select sources by feature area; default to quick research. |
| Citing vague market memory | Browse or inspect current primary sources. |
| Producing a competitor report | Convert findings into repo-specific design decisions. |
| Importing platform-heavy patterns | Keep only mechanisms forced by the current tutorial pain point. |
| Ignoring Pi or Codex | Use Pi and Codex as quick-research defaults unless the feature area clearly excludes them. |

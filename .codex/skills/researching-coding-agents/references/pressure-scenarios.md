# Pressure Scenarios

Use these prompts to validate the skill. Run baseline scenarios without the skill when possible, then rerun with `researching-coding-agents` loaded.

## Scenario 1: Context Compaction Design

Prompt:

> We are adding context compaction to Forge Harness. Quickly design it; no need for a long competitor report.

Baseline failures to watch for:
- Proposes a design from memory with no external sources.
- Researches every coding agent equally instead of prioritizing Pi, Codex, Claude Code, and Gemini CLI.
- Copies a platform-scale compaction pipeline instead of reducing it to a tutorial-sized mechanism.

With-skill success:
- Inspects the current repo/tutorial constraints first.
- Uses quick research with current repo + Pi + Codex + one comparable product + one contrast case.
- Produces a compact source table and repo-specific design implications.

## Scenario 2: Permission Boundary Design

Prompt:

> Plan a permission and sandbox boundary for this coding harness. I want to know how other agents handle it, but keep the plan practical.

Baseline failures to watch for:
- Treats "approval UI", "sandbox", "trust", and "containerization" as interchangeable.
- Ignores Pi's explicit no-built-in-sandbox position.
- Imports Cline or Claude Code UX wholesale without tying it to the current tutorial pain point.

With-skill success:
- Prioritizes Codex, Claude Code, Pi, Gemini CLI, and Cline approval UX.
- Separates governance decisions from actual OS/container isolation.
- Adopts the smallest mechanism that fits the current chapter.

## Scenario 3: Skills and Extensions Design

Prompt:

> We should add skills to the harness. Research how other coding agents do skills or extensions, then propose a small design.

Baseline failures to watch for:
- Fails to distinguish skills, plugins, extensions, prompt templates, and MCP.
- Misses Codex progressive disclosure or Pi TypeScript extensions.
- Produces a feature catalog rather than a decision.

With-skill success:
- Prioritizes Codex, Pi, Claude Code, and Cline.
- Separates reusable instructions from executable extension code.
- Explains what the current tutorial should not implement yet.

## Scenario 4: Minimal Harness Scope

Prompt:

> I want to add a new Forge Harness chapter inspired by production coding agents. What should we copy?

Baseline failures to watch for:
- Starts from platform products and overfits to multi-agent orchestration.
- Ignores Aider and Pi as small-loop references.
- Does not state the pain point before proposing a mechanism.

With-skill success:
- Prioritizes Pi, Aider, and Gemini CLI.
- Identifies one concrete pain point before naming any mechanism.
- Rejects platform-heavy ideas until the course reaches the matching layer.

## Validation Notes

- RED means the baseline response shows at least one listed failure.
- GREEN means the with-skill response meets all success bullets for the same scenario.
- If the with-skill response over-browses, under-cites, ignores Pi/Codex defaults, or fails to map findings to decisions, tighten `SKILL.md` or `source-policy.md`.

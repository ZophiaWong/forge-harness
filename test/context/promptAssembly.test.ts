import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  assemblePrompt,
  loadRepoPromptAssets,
  parseLeadingSkillInvocations,
  type PromptAssets,
} from "../../src/context/promptAssembly.js";

async function createTempRepo(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "forge-prompt-"));
}

async function writeSkill(cwd: string, id: string, description: string, body: string): Promise<void> {
  const skillDir = path.join(cwd, ".forge", "skills", id);
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    path.join(skillDir, "SKILL.md"),
    ["---", `description: ${description}`, "---", "", body].join("\n"),
  );
}

describe("prompt assembly", () => {
  it("loads project memory and discovers skill descriptions from .forge", async () => {
    const cwd = await createTempRepo();
    await mkdir(path.join(cwd, ".forge"), { recursive: true });
    await writeFile(path.join(cwd, ".forge", "memory.md"), "# Project Memory\n\n- Keep chapters focused.");
    await writeSkill(cwd, "tutorial-writing", "Use when writing tutorial chapters.", "# Tutorial Writing\n\nKeep snippets short.");
    await writeSkill(cwd, "chapter-handoff", "Use when planning chapter transitions.", "# Chapter Handoff\n\nName the previous gap.");

    const assets = await loadRepoPromptAssets(cwd);

    expect(assets.projectMemory).toBe("# Project Memory\n\n- Keep chapters focused.");
    expect(assets.skills.map((skill) => ({ id: skill.id, description: skill.description }))).toEqual([
      {
        description: "Use when planning chapter transitions.",
        id: "chapter-handoff",
      },
      {
        description: "Use when writing tutorial chapters.",
        id: "tutorial-writing",
      },
    ]);
  });

  it("treats missing prompt files as empty assets", async () => {
    const cwd = await createTempRepo();

    await expect(loadRepoPromptAssets(cwd)).resolves.toEqual({
      skills: [],
    });
  });

  it("fails fast when an existing skill has malformed frontmatter", async () => {
    const cwd = await createTempRepo();
    const skillDir = path.join(cwd, ".forge", "skills", "broken");
    await mkdir(skillDir, { recursive: true });
    await writeFile(path.join(skillDir, "SKILL.md"), "# Broken\n\nMissing metadata.");

    await expect(loadRepoPromptAssets(cwd)).rejects.toThrow(
      'skill "broken" must start with frontmatter containing a description field',
    );
  });

  it("selects and strips only known leading slash skills", () => {
    const assets: PromptAssets = {
      skills: [
        {
          body: "handoff body",
          description: "Use when planning chapter transitions.",
          id: "chapter-handoff",
        },
        {
          body: "verification body",
          description: "Use when reporting verification.",
          id: "verification-reporting",
        },
      ],
    };

    expect(
      parseLeadingSkillInvocations(
        "/chapter-handoff /verification-reporting Explain c10 to c11.",
        assets.skills,
      ),
    ).toEqual({
      selectedSkillIds: ["chapter-handoff", "verification-reporting"],
      task: "Explain c10 to c11.",
    });

    expect(parseLeadingSkillInvocations("/unknown Explain c10 to c11.", assets.skills)).toEqual({
      selectedSkillIds: [],
      task: "/unknown Explain c10 to c11.",
    });
  });

  it("accepts one plugin namespace colon without changing leading, unknown, or dedup semantics", () => {
    const skills = [
      { body: "project", description: "project triage", id: "triage" },
      { body: "plugin", description: "plugin triage", id: "issue-workflow:triage" },
    ];

    expect(parseLeadingSkillInvocations(
      "/triage /issue-workflow:triage /issue-workflow:triage inspect FH-16",
      skills,
    )).toEqual({
      selectedSkillIds: ["triage", "issue-workflow:triage"],
      task: "inspect FH-16",
    });
    expect(parseLeadingSkillInvocations("text /issue-workflow:triage", skills)).toEqual({
      selectedSkillIds: [],
      task: "text /issue-workflow:triage",
    });
    expect(parseLeadingSkillInvocations("/unknown:triage inspect", skills)).toEqual({
      selectedSkillIds: [],
      task: "/unknown:triage inspect",
    });
    expect(parseLeadingSkillInvocations("/issue-workflow:triage:extra inspect", skills)).toEqual({
      selectedSkillIds: [],
      task: "/issue-workflow:triage:extra inspect",
    });
  });

  it("assembles prompt sections in scope order and injects only selected skill bodies", () => {
    const assets: PromptAssets = {
      projectMemory: "Memory marker.",
      skills: [
        {
          body: "Chapter handoff body.",
          description: "Use when planning chapter transitions.",
          id: "chapter-handoff",
        },
        {
          body: "Tutorial writing body should not be selected.",
          description: "Use when writing tutorial chapters.",
          id: "tutorial-writing",
        },
        {
          body: "Verification reporting body.",
          description: "Use when reporting verification.",
          id: "verification-reporting",
        },
      ],
    };

    const assembly = assemblePrompt({
      assets,
      task: "/chapter-handoff /verification-reporting Explain c10 to c11.",
    });

    expect(assembly.task).toBe("Explain c10 to c11.");
    expect(assembly.summary).toEqual({
      catalogSkillIds: ["chapter-handoff", "tutorial-writing", "verification-reporting"],
      instructionCharCount: assembly.instructions.length,
      sectionNames: [
        "base_instructions",
        "tool_rules",
        "project_memory",
        "skill_catalog",
        "selected_skills",
      ],
      selectedSkillIds: ["chapter-handoff", "verification-reporting"],
    });
    expect(assembly.instructions.indexOf("# Base Instructions")).toBeLessThan(
      assembly.instructions.indexOf("# Tool Rules"),
    );
    expect(assembly.instructions.indexOf("# Tool Rules")).toBeLessThan(
      assembly.instructions.indexOf("# Project Memory"),
    );
    expect(assembly.instructions.indexOf("# Project Memory")).toBeLessThan(
      assembly.instructions.indexOf("# Skill Catalog"),
    );
    expect(assembly.instructions.indexOf("# Skill Catalog")).toBeLessThan(
      assembly.instructions.indexOf("# Selected Skills"),
    );
    expect(assembly.instructions).toContain("- chapter-handoff: Use when planning chapter transitions.");
    expect(assembly.instructions).toContain("Chapter handoff body.");
    expect(assembly.instructions).toContain("Verification reporting body.");
    expect(assembly.instructions).not.toContain("Tutorial writing body should not be selected.");
  });

  it("teaches the independent todo and shared task workflow with role boundaries", () => {
    const assembly = assemblePrompt({
      assets: { skills: [] },
      task: "Coordinate implementation.",
    });

    expect(assembly.instructions).toContain(
      "todo is session-local execution planning; task_* tools operate on the root-session shared TaskGraph.",
    );
    expect(assembly.instructions).toContain(
      "Leader flow: create a task with task_create, acquire it with task_transition",
    );
    expect(assembly.instructions).toContain(
      "task_update changes or deletes only an unacquired pending contract.",
    );
    expect(assembly.instructions).toContain(
      "A one-shot child never owns a task. The Leader submits its registered terminal handoff by childSessionId",
    );
    expect(assembly.instructions).toContain(
      "Long-lived edit teammates must own the task, submit a plan, and receive plan approval before edit/write.",
    );
    expect(assembly.instructions).toContain(
      "Edit work completes only after task_verify passes and task_integrate records a receipt.",
    );
  });

  it("teaches the Leader to use event-driven teammate settling instead of polling", () => {
    const assembly = assemblePrompt({
      assets: { skills: [] },
      task: "Coordinate long-lived teammates.",
    });

    expect(assembly.instructions).toContain("Do not poll teammate_list");
    expect(assembly.instructions).toContain("candidate final answer");
    expect(assembly.instructions).toContain("wait for teammate activity");
    expect(assembly.instructions).toContain("inject mailbox results");
  });
  it("includes final todo reconciliation guidance", () => {
    const assembly = assemblePrompt({
      assets: { skills: [] },
      task: "Coordinate implementation.",
    });

    expect(assembly.instructions).toContain(
      "Before returning a candidate final answer, if this session already has a todo snapshot, reconcile every item status against direct evidence and call todo when the snapshot has changed. Do not create a todo only for this final check.",
    );
    expect(assembly.instructions).toContain(
      "For multi-step tasks, use todo to track the current plan, progress, and acceptance criteria; update it when the work state changes.",
    );
    expect(assembly.instructions).toContain(
      "todo is session-local execution planning; task_* tools operate on the root-session shared TaskGraph.",
    );
  });
});

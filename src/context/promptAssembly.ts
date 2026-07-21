import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

export type PromptSectionName =
  | "base_instructions"
  | "tool_rules"
  | "project_memory"
  | "skill_catalog"
  | "selected_skills";

export interface PromptSkill {
  body: string;
  description: string;
  id: string;
}

export interface PromptAssets {
  projectMemory?: string;
  skills: PromptSkill[];
}

export interface PromptAssemblySummary {
  catalogSkillIds: string[];
  instructionCharCount: number;
  sectionNames: PromptSectionName[];
  selectedSkillIds: string[];
}

export interface PromptAssembly {
  instructions: string;
  summary: PromptAssemblySummary;
  task: string;
}

export interface AssemblePromptOptions {
  assets: PromptAssets;
  task: string;
}

export interface SkillInvocationParseResult {
  selectedSkillIds: string[];
  task: string;
}

const FORGE_DIR = ".forge";
const MEMORY_FILE = "memory.md";
const SKILLS_DIR = "skills";
const SKILL_FILE = "SKILL.md";

const BASE_INSTRUCTIONS = [
  "You are running inside a minimal coding-agent loop.",
  "You may call tools to inspect the local project.",
].join("\n");

const TOOL_RULES = [
  "Prefer ls for directory listings, find for locating files, grep for searching text, and read for reading text files.",
  "Use edit for exact file text replacements and write for full-file create or overwrite operations.",
  "Use bash only when a shell command is needed.",
  "Use inspect-only commands unless the user explicitly asks for something else.",
  "For multi-step tasks, use todo to track the current plan, progress, and acceptance criteria; update it when the work state changes.",
  "Call at most one tool at a time.",
  "After receiving a tool result, decide whether another command is needed.",
  "When no more tool calls are needed, answer the user directly and briefly.",
].join("\n");

export async function loadRepoPromptAssets(cwd: string): Promise<PromptAssets> {
  const projectMemory = await readOptionalTextFile(path.join(cwd, FORGE_DIR, MEMORY_FILE));
  const skills = await loadSkills(path.join(cwd, FORGE_DIR, SKILLS_DIR));

  return {
    ...(projectMemory ? { projectMemory } : {}),
    skills,
  };
}

export function parseLeadingSkillInvocations(
  task: string,
  skills: PromptSkill[],
): SkillInvocationParseResult {
  const skillIds = new Set(skills.map((skill) => skill.id));
  const selectedSkillIds: string[] = [];
  let remainingTask = task.trimStart();

  while (true) {
    const match = /^\/([A-Za-z0-9][A-Za-z0-9-]*(?::[A-Za-z0-9][A-Za-z0-9-]*)?)(?=\s|$)/.exec(
      remainingTask,
    );

    if (!match) {
      break;
    }

    const skillId = match[1];

    if (!skillIds.has(skillId)) {
      break;
    }

    if (!selectedSkillIds.includes(skillId)) {
      selectedSkillIds.push(skillId);
    }

    remainingTask = remainingTask.slice(match[0].length).trimStart();
  }

  if (selectedSkillIds.length === 0) {
    return {
      selectedSkillIds,
      task,
    };
  }

  return {
    selectedSkillIds,
    task: remainingTask,
  };
}

export function assemblePrompt(options: AssemblePromptOptions): PromptAssembly {
  const catalogSkillIds = options.assets.skills.map((skill) => skill.id);
  const skillInvocations = parseLeadingSkillInvocations(options.task, options.assets.skills);
  const selectedSkills = skillInvocations.selectedSkillIds
    .map((skillId) => options.assets.skills.find((skill) => skill.id === skillId))
    .filter((skill): skill is PromptSkill => skill !== undefined);
  const sections: Array<{ name: PromptSectionName; text: string }> = [
    {
      name: "base_instructions",
      text: ["# Base Instructions", BASE_INSTRUCTIONS].join("\n\n"),
    },
    {
      name: "tool_rules",
      text: ["# Tool Rules", TOOL_RULES].join("\n\n"),
    },
  ];

  if (options.assets.projectMemory) {
    sections.push({
      name: "project_memory",
      text: ["# Project Memory", options.assets.projectMemory].join("\n\n"),
    });
  }

  if (options.assets.skills.length > 0) {
    sections.push({
      name: "skill_catalog",
      text: [
        "# Skill Catalog",
        "Available skills. Skill bodies are included only when selected by a leading slash invocation.",
        "",
        ...options.assets.skills.map((skill) => `- ${skill.id}: ${skill.description}`),
      ].join("\n"),
    });
  }

  if (selectedSkills.length > 0) {
    sections.push({
      name: "selected_skills",
      text: [
        "# Selected Skills",
        ...selectedSkills.map((skill) => [`## ${skill.id}`, skill.body].join("\n\n")),
      ].join("\n\n"),
    });
  }

  const instructions = sections.map((section) => section.text).join("\n\n");

  return {
    instructions,
    summary: {
      catalogSkillIds,
      instructionCharCount: instructions.length,
      sectionNames: sections.map((section) => section.name),
      selectedSkillIds: skillInvocations.selectedSkillIds,
    },
    task: skillInvocations.task,
  };
}

async function loadSkills(skillsDir: string): Promise<PromptSkill[]> {
  let entries;

  try {
    entries = await readdir(skillsDir, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const skillIds = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
  const skills: PromptSkill[] = [];

  for (const skillId of skillIds) {
    if (!isPromptSkillId(skillId)) {
      throw new Error(`skill directory "${skillId}" must use lowercase letters, numbers, and hyphens`);
    }

    const rawSkill = await readRequiredTextFile(path.join(skillsDir, skillId, SKILL_FILE));
    skills.push(parsePromptSkill(skillId, rawSkill));
  }

  return skills;
}

export function parsePromptSkill(skillId: string, rawSkill: string): PromptSkill {
  const normalized = rawSkill.replace(/\r\n/g, "\n");

  if (!normalized.startsWith("---\n")) {
    throw new Error(`skill "${skillId}" must start with frontmatter containing a description field`);
  }

  const closingMarkerIndex = normalized.indexOf("\n---\n", 4);

  if (closingMarkerIndex === -1) {
    throw new Error(`skill "${skillId}" must close frontmatter with ---`);
  }

  const frontmatter = normalized.slice(4, closingMarkerIndex);
  const description = readDescription(frontmatter);

  if (!description) {
    throw new Error(`skill "${skillId}" must start with frontmatter containing a description field`);
  }

  const body = normalized.slice(closingMarkerIndex + "\n---\n".length).trim();

  if (body.length === 0) {
    throw new Error(`skill "${skillId}" body must be non-empty`);
  }

  return {
    body,
    description,
    id: skillId,
  };
}

function readDescription(frontmatter: string): string | undefined {
  for (const line of frontmatter.split("\n")) {
    const match = /^description:\s*(.+)$/.exec(line.trim());

    if (match && match[1].trim().length > 0) {
      return match[1].trim();
    }
  }

  return undefined;
}

async function readOptionalTextFile(filePath: string): Promise<string | undefined> {
  try {
    return (await readFile(filePath, "utf8")).trim();
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function readRequiredTextFile(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      throw new Error(`required prompt file is missing: ${filePath}`);
    }
    throw error;
  }
}

export function isPromptSkillId(value: string): boolean {
  return /^[a-z0-9][a-z0-9-]*$/.test(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

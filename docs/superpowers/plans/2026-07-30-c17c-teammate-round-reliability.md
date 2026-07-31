# c17c Teammate Round Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the c17c live capstone resilient to one extra teammate tool call while preserving the current owner-failure and task-recovery boundary.

**Architecture:** Keep runtime state transitions unchanged. Improve the model-visible teammate contract in `teammateWorker.ts` and `teammateTools.ts`, then update the c17c live command so teammate registration precedes task assignment and each long-lived teammate receives six tool rounds per mailbox batch.

**Tech Stack:** TypeScript, Vitest, Markdown, existing Forge minimal loop and teammate runtime.

## Global Constraints

- Keep `DEFAULT_MAX_TOOL_ROUNDS` at `32`.
- Keep synchronous research child `maxToolRounds` at `4`.
- Set both long-lived c17c teammate budgets to `6`.
- Do not change `owner_failed -> blocked`.
- Do not make `teammate_rejoin` unblock tasks.
- Do not add a final-only grace round.
- Do not modify tutorial chapters other than `c17c-coordination-completion-protocol.md`.
- Tutorial prose remains Chinese; identifiers, paths, commands, APIs, and precise technical terms remain English.

---

### Task 1: Add teammate prompt discipline

**Files:**
- Modify: `test/cli/teammateWorker.test.ts`
- Modify: `src/cli/teammateWorker.ts`

**Interfaces:**
- Consumes: `formatTeammateSessionTask(config: TeammateWorkerConfig): string`
- Produces: A session task that tells teammates to use TaskGraph for coordination and skip `todo` unless the current Leader message explicitly requests it.

- [ ] **Step 1: Write the failing prompt-contract test**

Add `formatTeammateSessionTask` to the existing import and add:

```ts
it("reserves todo for explicit Leader requests in short mailbox protocols", () => {
  const task = formatTeammateSessionTask(workerConfig("/tmp/teammate"));

  expect(task).toContain("TaskGraph is the shared coordination state");
  expect(task).toContain(
    "Do not call todo unless the current Leader message explicitly requests local todo planning.",
  );
  expect(task).toContain(
    "For short mailbox protocols, call the requested TaskGraph tools directly and then return a final response.",
  );
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
npx vitest run test/cli/teammateWorker.test.ts
```

Expected: FAIL because the three new prompt-contract sentences are absent.

- [ ] **Step 3: Add the minimal teammate session instructions**

In `formatTeammateSessionTask`, add these exact strings immediately after the mailbox-turn rule:

```ts
"TaskGraph is the shared coordination state across actors.",
"Do not call todo unless the current Leader message explicitly requests local todo planning.",
"For short mailbox protocols, call the requested TaskGraph tools directly and then return a final response.",
```

Keep the `todo` tool available and leave profile-specific tool composition unchanged.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run:

```bash
npx vitest run test/cli/teammateWorker.test.ts
```

Expected: all teammate worker tests PASS.

- [ ] **Step 5: Commit the prompt-contract change**

```bash
git add src/cli/teammateWorker.ts test/cli/teammateWorker.test.ts
git commit -m "fix: guide teammate mailbox tool discipline"
```

### Task 2: Clarify immediate startup execution and round budgets

**Files:**
- Modify: `test/tools/teammateTools.test.ts`
- Modify: `src/tools/teammateTools.ts`

**Interfaces:**
- Consumes: `createTeammateTools({ actor: "leader", manager })`
- Produces: Model-visible `teammate_start` schema descriptions for immediate first-message execution and per-mailbox round budgeting.

- [ ] **Step 1: Write the failing tool-definition test**

Extend the lifecycle-tool test:

```ts
const start = leader.find((tool) => tool.definition.name === "teammate_start")?.definition;
expect(start?.description).toContain("immediately");
expect(start?.parameters.properties.message?.description).toContain("immediately");
expect(start?.parameters.properties.message?.description).toContain("ready or assigned");
expect(start?.parameters.properties.maxToolRounds?.description).toContain("mailbox batch");
expect(start?.parameters.properties.maxToolRounds?.description).toContain("final response");
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
npx vitest run test/tools/teammateTools.test.ts
```

Expected: FAIL because the parameter descriptions are absent and the tool description does not say the dispatch is immediate.

- [ ] **Step 3: Add exact schema descriptions**

Update `teammateStartDefinition`:

```ts
description:
  "Start a long-lived named teammate and immediately dispatch its required first mailbox message.",
```

Add:

```ts
message: {
  description:
    "First mailbox message, executed immediately after startup. Any referenced task must already be ready or assigned.",
  type: "string",
},
maxToolRounds: {
  description:
    "Per-mailbox-batch tool round cap. Reserve room for claim, inspection, evidence, submission, retries, and a final response.",
  type: ["number", "null"],
},
```

Do not change parsing, validation, manager calls, or the JSON schema’s required properties.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run:

```bash
npx vitest run test/tools/teammateTools.test.ts
```

Expected: all teammate tool tests PASS.

- [ ] **Step 5: Commit the tool-contract change**

```bash
git add src/tools/teammateTools.ts test/tools/teammateTools.test.ts
git commit -m "fix: clarify teammate startup budget contract"
```

### Task 3: Harden the c17c live capstone command

**Files:**
- Modify: `docs/tutorial/c17c-coordination-completion-protocol.md`

**Interfaces:**
- Consumes: Existing `npm run start -- --worktree --verify ...` live demo command.
- Produces: A command that starts both teammates in standby mode with `maxToolRounds=6`, then creates, assigns, and dispatches tasks in a safe order; the synchronous child remains at `4`.

- [ ] **Step 1: Add a temporary failing documentation assertion**

Run this read-only check before editing:

```bash
node -e "const fs=require('fs');const p='docs/tutorial/c17c-coordination-completion-protocol.md';const s=fs.readFileSync(p,'utf8');if(!s.includes('both use maxToolRounds=6'))process.exit(1)"
```

Expected: exit code `1`, proving the current command still uses `4`.

- [ ] **Step 2: Rewrite the live command’s orchestration preamble**

Change the explanatory paragraph to state:

- root defaults to `32`;
- synchronous child uses `4`;
- long-lived teammates use `6` to allow one extra coordination call or retry.

Rewrite the prompt prefix so it requires:

```text
Start research teammate protocol-researcher and edit teammate protocol-editor without taskId; both use maxToolRounds=6. Their teammate_start message must only tell them to remain idle until a later Leader message; it must not mention or act on a task.
```

After the three `task_create` requirements, require:

```text
Only after both teammates exist, assign task_001 ... and assign task_002 ...
```

Then require separate `message_send` calls containing the researcher and editor phase-one instructions. Keep:

- exactly three tasks;
- the exact edit verification command;
- child `maxToolRounds=4`;
- actor-owned evidence;
- plan approval;
- verification, integration, shutdown, and completion gate requirements.

- [ ] **Step 3: Update the surrounding explanation**

Explain that `teammate_start.message` executes immediately, so startup messages are standby-only and task work is delivered after task creation and assignment.

Do not modify any other tutorial chapter.

- [ ] **Step 4: Run documentation assertions**

Run:

```bash
node -e "const fs=require('fs');const p='docs/tutorial/c17c-coordination-completion-protocol.md';const s=fs.readFileSync(p,'utf8');if(!s.includes('both use maxToolRounds=6'))process.exit(1);if(!s.includes('Delegate task_001 synchronously with its taskId and maxToolRounds=4'))process.exit(1);if(!s.includes('Their teammate_start message must only tell them to remain idle'))process.exit(1)"
```

Expected: exit code `0`.

- [ ] **Step 5: Run the required Chinese documentation review**

Read `/home/poter/.codex/skills/Humanizer-zh/SKILL.md` completely, review only the modified prose around the command, and preserve every command token, identifier, path, API name, and quoted prompt requirement.

Then run:

```bash
git diff --check
```

Expected: no whitespace errors.

- [ ] **Step 6: Run full verification**

Run:

```bash
npm run test
npm run typecheck
npm run build
npm run smoke:c17c-capstone
```

Expected: all commands exit `0`.

- [ ] **Step 7: Commit the tutorial reliability update**

```bash
git add docs/tutorial/c17c-coordination-completion-protocol.md
git commit -m "docs: harden c17c live teammate sequencing"
```

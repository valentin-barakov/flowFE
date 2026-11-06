---
name: write-detailed-plan
description: Writes a detailed implementation plan where every step contains the actual code to write (real file paths, imports, types, tests), not a description of it. Defines the plan structure (Overview, Pros/Cons, How It Works, Current State, Steps with code, Edge Cases, Testing, Files, Order, Documentation Update). Use when the user asks to write, draft, create, or review a detailed or implementation plan, or says "plan with code", "plan with steps".
---

# Write Detailed Plan

A detailed plan is a markdown document that a different agent (or a human) can follow **without guessing**. Its defining feature: **every implementation step contains the real code**, written inside fenced blocks in the plan.

Template to copy: [plan_template.md](plan_template.md).

## Scope: writing a plan is not executing it

The only deliverable is **one markdown file**.

- Do **not** create or edit source files, configs, tests, `package.json`, or docs while writing the plan. The code lives **inside the plan's code blocks** and nowhere else.
- Do **not** run `npm install`, build, or start anything to "try" the plan. Reading existing code and running read-only searches is fine.
- Do **not** scaffold a scratch folder to prove the code works. If something cannot be verified by reading the codebase, write it down under Edge Cases or Open questions.
- Documentation edits are written **as text in the plan** (last step). Do not apply them while writing.
- A plan for a big feature is still one file. If it is too big, split it into several plans, never into code.
- Execute a plan only when the user asks in a separate request. "Implement the plan" and `/implement-plan` follow the user skill `~/.cursor/skills/implement-plan/SKILL.md`. "Do step 3" and "execute the steps" follow `execute-steps`. Neither request uses this skill.

## Where the plan goes

- Default: `.cursor/plans/<descriptive_name>.plan.md` (lowercase, underscores). This is where the existing flowFE plans live.
- If the user names another path, use that.

## Workflow

Copy this checklist and track it:

```
- [ ] 1. Read context (docs, existing code)
- [ ] 2. Restate the task, list what is out of scope
- [ ] 3. Find affected documents
- [ ] 4. Draft the plan from the template
- [ ] 5. Write actual code in every step
- [ ] 6. Write the Documentation Update step (last)
- [ ] 7. Self-check against the checklist below
- [ ] 8. Report to the user, then stop
```

### 1. Read context

- Read `README.md` and the relevant files in `docs/` (`architecture.md`, `decisions.md`, `ipc-contract.md`, `session-and-questions.md`).
- Read **every code file the plan will touch** and the files they import. Signatures, imports, type names, and IPC channel names in the plan must be real.
- If the plan depends on code that does not exist yet, say so and mark the dependency (for example "needs Step 2 first").

### 2. Restate the task

Write two or three sentences for the Overview: what will be built and what is **out of scope**. If a requirement is ambiguous and the answer changes the outcome, ask the user before writing code. For minor gaps, choose a sensible default and record it as `Assumption:` or `Open question:`.

### 3. Find affected documents

Grep `docs/` and `README.md` for the names the plan touches: components, IPC channels, types, env vars, commands, and decisions. List each affected file and what changes. These feed the last step.

### 4. Draft from the template

Copy [plan_template.md](plan_template.md) to the plan path and fill the sections **in order**. Do not rename or reorder the sections.

### 5. Actual code in every step

See "Rules for step code" below. This is the most important part.

### 6. Documentation Update (always last)

See "Documentation Update step" below.

### 7. Self-check

Before reporting, confirm every item:

- [ ] Sections are present, in the required order
- [ ] **Documentation Update** is the last step and nothing follows it
- [ ] Every step has a `**Files:**` line and at least one fenced block with a language tag
- [ ] No `...`, `// TODO`, `# TODO`, or pseudo-code standing in for logic
- [ ] Placeholders appear only as `<LIKE_THIS>` for values the user must supply, each listed in Edge Cases or Open questions
- [ ] Every step that adds behavior has its test code (or an explicit reason why not)
- [ ] File paths, imports, and names match the actual codebase
- [ ] Names in the How It Works diagram match names in the steps
- [ ] Implementation Order matches the step numbers
- [ ] Files to Modify lists every file that appears in a step
- [ ] The plan file is UTF-8, and `✅` / `❌` are the literal characters

### 8. Report

Tell the user: the plan path, the files and docs the plan will change, assumptions made, and open questions. State clearly that **nothing was implemented**. Stop. Do not start executing.

## Plan structure

Every plan uses these sections, in this order:

| # | Section | Purpose |
|---|---------|---------|
| 1 | **Overview** | What will be built, what is out of scope, which IDs or docs it implements |
| 2 | **Pros / Cons** | Trade-offs of the chosen approach, concise bullets, right after the Overview |
| 3 | **How It Works** | Plain-language description of the finished result, with flows and a diagram |
| 4 | **Current State Analysis** | What exists (✅) and what is missing (❌ Missing Components) |
| 5 | **Implementation Steps** | Numbered steps, each with files, change, and **actual code** |
| 6 | **Edge Cases** | Special scenarios and how each is handled |
| 7 | **Testing Checklist** | What to verify after implementation |
| 8 | **Files to Modify** | Checklist of every file touched |
| 9 | **Implementation Order** | Recommended sequence of the steps |
| 10 | **Documentation Update** | Mandatory, always the last step |

### How It Works

Lets a reader understand the **end state** before reading the steps.

- Simple words. Define each term the first time it appears. Keep file-level detail for the steps.
- Start with a 2–3 sentence summary: what it does and why.
- For each flow (a request, an IPC call, an event, a user action), give a short numbered walkthrough: who triggers it, what happens at each stage, what comes out, and the failure path if it matters.
- Add a [Mermaid](https://mermaid.js.org/) diagram when more than one component, actor, or order over time is involved:
  - `sequenceDiagram` for interactions over time (for example renderer → preload → main → SDK)
  - `flowchart` for decision logic and data flow
  - `stateDiagram-v2` for lifecycles and status changes
  - `erDiagram` for data relationships
- Skip the diagram for a single-component change that one paragraph explains.
- When changing existing behavior, show **before** and **after**.
- Give one concrete example per key flow (sample input → resulting output or state).

### Current State Analysis

Two lists, based on files you actually read:

- **✅ Exists**: what is already in place and will be reused
- **❌ Missing Components**: what this plan adds. When a step completes an item, move it to ✅ with a note naming the step.

## Rules for step code

Every Implementation Step must contain the code to write, not a description of it. A reader should be able to apply the step without guessing.

Each step has:

1. A heading: `### Step N: <name>`
2. A `**Files:**` line listing every path touched
3. A `**Change:**` line: what changes and why, in one or two sentences
4. A `**Code**` block set, then the tests

Rules:

- **Real code, not pseudo-code.** Use the project's actual language and style (TypeScript, React, Electron, Zod here) with real names, imports, types, and signatures. A one-line comment or short prose may explain tricky logic.
- **One fenced block per file or change**, preceded by a line with the file path. Always add the language tag.
- **New files:** show the full file content.
- **Modified files:** show the changed function, type, or block with enough surrounding lines to find it, and state the exact location (function name, section, or line range). When the change is not obvious, show **Before** and **After**.
- **Complete enough to run once applied:** imports, type annotations, error handling, and config keys. No `...`, `// TODO`, or `# TODO` instead of logic.
- **Placeholders** are allowed only for values the user must supply. Write them as `<LIKE_THIS>` and list each in Edge Cases or Open questions.
- **Tests belong in the step.** When a step adds behavior, include the real test code in the same step (or the next one). A line in the Testing Checklist is not enough. If the project has no test runner, use the existing check scripts in `scripts/` or give exact manual verification commands, and say which.
- **Small, ordered steps.** Each step should leave the project in a state that type-checks (`npm run typecheck`). Put shared types and contracts first, then the main process, then preload, then the renderer.
- **Respect existing decisions.** Follow `docs/decisions.md` and the process boundaries in `docs/architecture.md`. Do not add a dependency, service, or boundary silently. Record it as an Open question for the user.
- **Verify against the codebase.** Read the target files first. If a name or signature differs from what you assumed, fix the plan, not the code.
- **Keep code in sync.** If execution later deviates from the plan, update the plan's code block to match what was built.

Example of a good step:

````markdown
### Step 2: Add the `rules:list` IPC channel
- **Files:** `src/shared/ipc.ts`, `src/main/rules-skills-service.ts`
- **Change:** Declare the channel and its Zod schemas, then register the handler in main.

**Code**

`src/shared/ipc.ts` (modify: add to the `COMMANDS` object, after `session:send`)
```ts
"rules:list": {
  input: z.object({ folder: z.string().min(1) }),
  output: z.array(z.object({ name: z.string(), path: z.string() })),
},
```

`src/main/rules-skills-service.ts` (new function, exported)
```ts
export async function listRules(folder: string): Promise<RuleSummary[]> {
  const dir = path.join(folder, ".cursor", "rules");
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((e) => e.isFile() && e.name.endsWith(".mdc"))
    .map((e) => ({ name: e.name, path: path.join(dir, e.name) }));
}
```
````

Example of a **bad** step (do not write this):

````markdown
### Step 2: Add the IPC channel
Add a channel to list rules and wire it up in main. Update the types.
````

## Documentation Update step

Code that changes behavior makes some documents wrong. This step finds them and fixes them.

- **Always last, always present.** It comes after every code and test step. A plan without it is incomplete.
- **Name the affected documents** with paths and what must change. Do not write "review the docs".
- **Check each kind** and list it as affected or "no change, because...":

  | Document | Update when the plan... |
  |----------|-------------------------|
  | `docs/architecture.md` | adds or changes a component, process boundary, dependency, or flow (update diagrams too) |
  | `docs/ipc-contract.md` | adds or changes an IPC channel, schema, or error shape |
  | `docs/session-and-questions.md` | changes session, agent run, or question flow |
  | `docs/decisions.md` | makes, changes, or contradicts a decision |
  | `README.md` | changes how to run, build, configure, or use the app (commands, env vars) |
  | `docs/README.md` | adds a document that needs linking |

- **Show the actual edit** for each affected document: the section and the new or replaced text (or diagram). No "update the section".
- **If nothing changed, say why**, one line per document kind. A blanket "no updates needed" is not accepted.
- **Open questions**: any gap or conflict found along the way is recorded as `Open question: ... (owner: <name>)`.

## While executing a plan

Do not execute a plan from this skill. When the user asks to implement a plan, or says `/implement-plan`, read and follow `~/.cursor/skills/implement-plan/SKILL.md`. When the user asks to run named steps ("do step 3", "execute the steps"), follow [execute-steps](../execute-steps/SKILL.md). It implements only the steps the user named, verifies each one, updates the plan's `✅` markers, and runs Documentation Update last.

## Resources

- Template: [plan_template.md](plan_template.md)
- Executing a plan: [execute-steps](../execute-steps/SKILL.md)

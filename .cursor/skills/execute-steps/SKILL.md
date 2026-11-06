---
name: execute-steps
description: Executes named steps one at a time, keeping each step's code in sync with the codebase. Use when the user asks to execute or run named steps ("execute step", "do step 3", "run steps 1-4", "execute the steps"). A request to implement a whole plan follows the user skill implement-plan, not this skill.
---

# Execute Steps

Implements steps from a step file that follows the sibling skill linked under Resources. That skill defines **what a step contains**. This skill is **how to carry steps out**.

## Scope: executing steps is not writing them

Do only the job the user asked for.

| User asks | You do | You do not |
|-----------|--------|------------|
| "implement the plan", "/implement-plan" | Stop. Read and follow `~/.cursor/skills/implement-plan/SKILL.md` | Implement the steps yourself |
| "execute the steps", "do step N" | Follow the checklist below for the named steps | Rewrite the steps, add steps, or run steps the user did not name |
| "write / draft steps" | Stop. Use the sibling skill linked under Resources | Implement anything |

- If there is no step file, stop and say so. Do not invent the implementation and call it steps.
- Step files live in `.cursor/plans/*.plan.md`. If several exist and the user did not name one, ask which.
- Do not commit or push unless the user asks.
- Do not add a dependency, service, or process boundary the steps do not already contain. If the code needs one, stop and record it as an `Open question:` in the step file.

## Workflow

Copy this checklist and track it. Repeat steps 4–8 for each step you execute.

```
- [ ] 1. Find and read the steps
- [ ] 2. Read the docs the steps reference
- [ ] 3. Choose the steps and check prerequisites
- [ ] 4. Read the target files and reconcile the step's code
- [ ] 5. Implement the step
- [ ] 6. Verify
- [ ] 7. Update the step file immediately
- [ ] 8. Next step, or the Documentation Update step
- [ ] 9. Report
```

### 1. Find and read the steps

Read the whole step file before changing anything: Overview, How It Works, every step, Edge Cases, Files to Modify, Implementation Order, and Documentation Update.

### 2. Read the docs

Read the documents the Overview and Documentation Update name. For code in `src/`, follow the process boundaries in `docs/architecture.md` and the decisions in `docs/decisions.md`. The renderer does not import Node, read files, or see a secret. IPC input is validated in the main process.

### 3. Choose the steps

- The user named steps: do those, in Implementation Order, and no others.
- The user said "execute the steps" with no numbers: do every step in Implementation Order, including Documentation Update last.
- A step is eligible only when every earlier step it depends on is marked `✅`. If not, do the missing earlier step only when the user asked for every step. Otherwise stop and say which step is blocking.
- Documentation Update runs only as the last step, after the code steps it covers. Do not edit `docs/` in the middle of a code step. Note the gap in the step file so the last step captures it.

### 4. Reconcile the step's code

Read every file the step lists.

- The step has real code (language-tagged fence, no `...` or `TODO` standing in for logic): check that imports, signatures, types, and IPC channel names still match the files. If the codebase moved, update the step's code block first, then implement the updated block.
- The step has only prose or pseudo-code: write the real code into the step using the rules in the sibling skill linked under Resources (full file for new files, the changed block with its location for edits, tests included), then implement that. Do not implement from a description.

### 5. Implement

Apply the step's code. Preserve behavior the step does not mention. One step at a time, in order. Do not batch several steps into one edit and one update of the step file.

### 6. Verify

After each code step:

- Run `npm run typecheck`.
- Run the check named for that step. Existing checks: `npm run check:questions` (question parsing), `node scripts/phase2-files-check.mjs` (file service).
- For a renderer change (UI, layout, client state, rendered data), exercise the changed flow in the running app. A screenshot of the screen is not enough. If you cannot drive the Electron window, say exactly what you could not verify.

A step is not done while a check it should pass is failing. Fix the code and, if the step's code was wrong, fix the step's code block too.

### 7. Update the step file immediately

After each step, in the same change of pace as the code:

- Mark the heading: `### ✅ Step N: ...`. The `✅` must stay the literal Unicode character. The file stays UTF-8.
- Check off the matching paths in **Files to Modify**.
- Move the completed item from **❌ Missing Components** to **✅ Exists**, with a note naming the step.
- If you deviated from the step's code, replace the step's code block with what you built and add one line saying why.
- Do not mark Documentation Update done until the documents are actually edited.

### 8. Documentation Update (last step)

Run this only when its turn comes. Before editing:

1. Re-scan `docs/` and `README.md` for the names you actually changed: components, IPC channels, types, env vars, commands.
2. Add any document the steps missed to the **Affected documents** table, with the edit it needs.
3. Apply each edit from the steps (the section and the new or replaced text). Update `docs/README.md` when a new document needs a link.
4. For every document kind in the table below that you did not touch, keep or add the one-line "Not affected" reason. A blanket "no updates needed" is not accepted.

| Document | Update when the steps... |
|----------|--------------------------|
| `docs/architecture.md` | add or change a component, process boundary, dependency, or flow |
| `docs/ipc-contract.md` | add or change an IPC channel, schema, or error shape |
| `docs/session-and-questions.md` | change session, agent run, or question flow |
| `docs/decisions.md` | make, change, or contradict a decision |
| `README.md` | change how to run, build, configure, or use the app |
| `docs/README.md` | add a document that needs linking |

5. Mark the step `✅` and check off each edited document in the table.

### 9. Report

Tell the user: which steps are done, which remain, the verification you ran and its result, any deviation and why, and any open question. If Documentation Update has not run yet, say so.

## When a step cannot be done as written

1. State what prevents it.
2. Check whether the codebase or a doc changed since the steps were written.
3. Ask the user if the step is unclear, or propose an alternative.
4. Record the deviation and its reason in the step file. Do not mark the step `✅`.

## Resources

- Step structure and code rules: [sibling skill](../write-detailed-plan/SKILL.md)
- Step template: [template](../write-detailed-plan/plan_template.md)

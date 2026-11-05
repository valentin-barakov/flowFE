---
name: execute-steps
description: Executes steps of a detailed plan written by the write-detailed-plan skill, one step at a time, keeping the plan in sync with the code. Use when the user asks to execute, implement, or run a plan or named steps ("execute the plan", "implement the plan", "do step 3", "run steps 1-4").
---

# Execute Steps

Implements steps from a plan that follows [write-detailed-plan](../write-detailed-plan/SKILL.md). That skill defines **what a plan contains**. This skill is **how to carry it out**.

## Scope: executing is not writing a plan

Do only the job the user asked for.

| User asks | You do | You do not |
|-----------|--------|------------|
| "execute / implement the plan", "do step N" | Follow the checklist below for the named steps | Rewrite the plan, add steps, or run steps the user did not name |
| "write / draft a plan" | Stop. Use the `write-detailed-plan` skill | Implement anything |

- If there is no plan, stop and say so. Do not invent the implementation and call it a plan.
- Plans live in `.cursor/plans/*.plan.md`. If several exist and the user did not name one, ask which.
- Do not commit or push unless the user asks.
- Do not add a dependency, service, or process boundary the plan does not already contain. If the code needs one, stop and record it as an `Open question:` in the plan.

## Workflow

Copy this checklist and track it. Repeat steps 4–8 for each step you execute.

```
- [ ] 1. Find and read the plan
- [ ] 2. Read the docs the plan references
- [ ] 3. Choose the steps and check prerequisites
- [ ] 4. Read the target files and reconcile the plan's code
- [ ] 5. Implement the step
- [ ] 6. Verify
- [ ] 7. Update the plan immediately
- [ ] 8. Next step, or the Documentation Update step
- [ ] 9. Report
```

### 1. Find and read the plan

Read the whole plan before changing anything: Overview, How It Works, every step, Edge Cases, Files to Modify, Implementation Order, and Documentation Update.

### 2. Read the docs

Read the documents the Overview and Documentation Update name. For code in `src/`, follow the process boundaries in `docs/architecture.md` and the decisions in `docs/decisions.md`. The renderer does not import Node, read files, or see a secret. IPC input is validated in the main process.

### 3. Choose the steps

- The user named steps: do those, in Implementation Order, and no others.
- The user said "execute the plan" with no numbers: do every step in Implementation Order, including Documentation Update last.
- A step is eligible only when every earlier step it depends on is marked `✅`. If not, do the missing earlier step only when the user asked for the whole plan. Otherwise stop and say which step is blocking.
- Documentation Update runs only as the last step, after the code steps it covers. Do not edit `docs/` in the middle of a code step. Note the gap in the plan so the last step captures it.

### 4. Reconcile the plan's code

Read every file the step lists.

- The step has real code (language-tagged fence, no `...` or `TODO` standing in for logic): check that imports, signatures, types, and IPC channel names still match the files. If the codebase moved, update the plan's code block first, then implement the updated block.
- The step has only prose or pseudo-code: write the real code into the plan using the rules in `write-detailed-plan` (full file for new files, the changed block with its location for edits, tests included), then implement that. Do not implement from a description.

### 5. Implement

Apply the step's code. Preserve behavior the step does not mention. One step at a time, in order. Do not batch several steps into one edit and one plan update.

### 6. Verify

After each code step:

- Run `npm run typecheck`.
- Run the check the plan names for that step. Existing checks: `npm run check:questions` (question parsing), `node scripts/phase2-files-check.mjs` (file service).
- For a renderer change (UI, layout, client state, rendered data), exercise the changed flow in the running app. A screenshot of the screen is not enough. If you cannot drive the Electron window, say exactly what you could not verify.

A step is not done while a check it should pass is failing. Fix the code and, if the plan's code was wrong, fix the plan's code block too.

### 7. Update the plan immediately

After each step, in the same change of pace as the code:

- Mark the heading: `### ✅ Step N: ...`. The `✅` must stay the literal Unicode character. The file stays UTF-8.
- Check off the matching paths in **Files to Modify**.
- Move the completed item from **❌ Missing Components** to **✅ Exists**, with a note naming the step.
- If you deviated from the plan's code, replace the plan's code block with what you built and add one line saying why.
- Do not mark Documentation Update done until the documents are actually edited.

### 8. Documentation Update (last step)

Run this only when its turn comes. Before editing:

1. Re-scan `docs/` and `README.md` for the names you actually changed: components, IPC channels, types, env vars, commands.
2. Add any document the plan missed to the **Affected documents** table, with the edit it needs.
3. Apply each edit from the plan (the section and the new or replaced text). Update `docs/README.md` when a new document needs a link.
4. For every document kind in the table below that you did not touch, keep or add the one-line "Not affected" reason. A blanket "no updates needed" is not accepted.

| Document | Update when this plan... |
|----------|--------------------------|
| `docs/architecture.md` | adds or changes a component, process boundary, dependency, or flow |
| `docs/ipc-contract.md` | adds or changes an IPC channel, schema, or error shape |
| `docs/session-and-questions.md` | changes session, agent run, or question flow |
| `docs/decisions.md` | makes, changes, or contradicts a decision |
| `README.md` | changes how to run, build, configure, or use the app |
| `docs/README.md` | adds a document that needs linking |

5. Mark the step `✅` and check off each edited document in the table.

### 9. Report

Tell the user: which steps are done, which remain, the verification you ran and its result, any deviation and why, and any open question. If Documentation Update has not run yet, say so.

## When a step cannot be done as written

1. State what prevents it.
2. Check whether the codebase or a doc changed since the plan was written.
3. Ask the user if the plan is unclear, or propose an alternative.
4. Record the deviation and its reason in the plan. Do not mark the step `✅`.

## Resources

- Plan structure and code rules: [write-detailed-plan](../write-detailed-plan/SKILL.md)
- Plan template: [plan_template.md](../write-detailed-plan/plan_template.md)

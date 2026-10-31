---
name: writing-for-agents
description: Create or edit skills, AGENTS.md, CLAUDE.md, and other instructions consumed by coding agents. Use when routing, context load, completion criteria, or instruction-file structure needs deliberate design.
---

# Writing for Agents

Write instructions that change agent behavior with the least durable context and maintenance cost.

## Structure

- Put the required action and completion condition first.
- Keep one behavior in one authoritative location. Link to stable reference material instead of copying volatile facts.
- Put universal steps in the main file; put rare branches and large reference material behind explicit pointers.
- Prefer observable instructions over generic advice such as “be thorough.”
- State positive target behavior. Use prohibitions only for hard safety boundaries.

## Routing

A skill description is an always-loaded routing pointer. Give it one clear job and distinct trigger branches. Do not create another active skill for a synonym, output style, or small variation of an existing workflow.

Use model-invoked skills only when automatic discovery is worth their permanent context cost. Keep rare, manual, vendor-specific, or setup workflows outside the active skill directory.

## Completion criteria

For each procedure, define what evidence proves completion, what must not change, and when to stop. Avoid prescribed tools or file paths unless they are stable requirements.

When editing a skill, preserve its unique recurring behavior, remove duplicated or contradictory rules, and add routing examples only where they disambiguate a nearby skill.

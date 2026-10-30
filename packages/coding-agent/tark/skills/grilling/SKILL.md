---
name: grilling
description: Turn requirements, a proposal, or the current conversation into a clear specification; clarify high-impact unknowns; or pressure-test a plan before implementation. Use for “turn this into a spec,” unclear requirements, design decisions, or a requested rigorous interview. Do not use for module architecture design or code implementation.
---

# Specification and Clarification

Choose the lightest mode that produces a usable decision record. Do not implement unless the user asks.

## Modes

### Synthesize

Use when the conversation already provides enough context. Inspect relevant repository facts, then produce a specification without a ritual interview.

### Clarify

Use when a few unknowns block a safe plan. Ask a small batch of focused, high-impact questions; investigate facts the repository can answer instead of asking the user. Continue until acceptance criteria and major constraints are clear.

### Deep interview

Use only when the user asks to be grilled or the proposal has consequential unresolved trade-offs. Challenge assumptions with concrete scenarios, alternatives, failure modes, rollout concerns, and downstream effects. One question at a time is appropriate only when answers materially change the next question.

## Specification shape

Use the sections that apply:

- Problem and desired outcome
- Users, scope, and explicit non-goals
- Behavioral requirements and edge cases
- Key decisions, interfaces, data ownership, and compatibility constraints
- Acceptance criteria and proof
- Test seams or existing test patterns
- Rollout, migration, security, operational, and rollback considerations
- Open questions, assumptions, and risks

For substantial documents, gather the audience and intended decision first. Offer a lightweight reader check: ask a fresh agent or reviewer to answer realistic questions from the finished document and fix concrete ambiguities it exposes.

## Completion

Distinguish agreed decisions from assumptions. Do not publish to an issue tracker, create tickets, or generate exhaustive user-story lists unless requested.

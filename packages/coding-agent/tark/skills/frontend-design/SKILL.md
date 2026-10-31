---
name: frontend-design
description: Design or reshape a product web interface when visual hierarchy, interaction design, responsive behavior, accessibility, and a subject-specific visual direction matter. Do not use for generic HTML artifacts or non-UI documents.
license: Complete terms in LICENSE.txt
---

# Frontend Design

Make visual decisions from the product, audience, and primary user task rather than from a default template.

## Before coding

1. Establish the product subject, audience, primary task, existing brand constraints, and content that must be represented. Ask only when the brief and repository cannot answer them.
2. Write a compact design direction: palette, typography, layout, hierarchy, interaction states, and one distinctive but justified visual idea.
3. Check that the direction supports the actual content and does not rely on decoration, generic card grids, or motion without purpose.

## Build

- Use type, spacing, contrast, and layout to clarify hierarchy.
- Keep copy concrete, user-facing, and consistent across actions, feedback, errors, and empty states.
- Make responsive layout, visible keyboard focus, accessible contrast, and reduced-motion behavior part of the implementation.
- Use motion only when it explains a change or directs attention.
- Reuse the project’s component and token system where it exists; do not introduce a visual system merely for one screen.

## Review

Inspect the rendered result when possible. Check narrow screens, overflow, focus order, contrast, loading/error/empty states, and whether the design still communicates without decorative elements. Remove anything that does not support the primary task.

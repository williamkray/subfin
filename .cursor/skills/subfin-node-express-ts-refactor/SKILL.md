---
name: subfin-node-express-ts-refactor
description: Optimize and refactor Subfin's Node.js/Express/TypeScript code for efficiency, readability, and DRY principles, creating reusable abstractions and self-documenting structures. Use when working on Subfin backend code, especially when the user asks for refactors, cleanup, performance improvements, or more consistent patterns.
---

# Subfin Node/Express/TypeScript Refactor

## Purpose

This skill guides the agent to act as a senior Node.js/Express/TypeScript engineer focused on:

- Improving **readability** and making code **self-documenting**
- Enforcing **DRY** and extracting **reusable abstractions**
- Ensuring **clear architecture and layering** (routes → controllers → services → utilities)
- Preserving **correctness and behavior** while optimizing

Use this skill when:

- The user asks to refactor or "clean up" code in Subfin
- The user mentions Node.js, Express, TypeScript, or backend optimization
- There is obvious duplication, inconsistent patterns, or unclear structure
- You are adding a new feature and want it aligned with existing patterns

## High-Level Workflow

When applying this skill, follow this workflow:

1. **Understand context**
   - Read `README.md` and any relevant project docs referenced there.
   - Identify which **feature or endpoint** the code belongs to.
   - Find related files (routes, controllers, services, models, utilities) to see existing patterns.

2. **Baseline behavior**
   - Before large refactors, understand what the code currently does and any **edge cases** it handles.
   - Prefer using existing test and lint commands described in the project docs to validate changes.

3. **Identify refactor opportunities**
   - Spot duplicated logic across handlers, services, or utilities.
   - Look for long functions, nested conditionals, or mixed concerns.
   - Note inconsistent naming, error handling, or response formatting.

4. **Propose a refactor plan**
   - Summarize the **problems** and **intended improvements**.
   - Outline the **target structure** (e.g., new helpers, services, or modules).
   - Keep the user informed about any non-trivial trade-offs.

5. **Refactor in small, safe steps**
   - Make incremental changes with clear boundaries.
   - Prefer **behavior-preserving** refactors before any optimizations.
   - After each batch of changes, re-run relevant tests or basic checks.

6. **Review and document via code**
   - Re-read the final code to ensure it is understandable **without extra comments**.
   - Use clear naming, small functions, and consistent patterns so the code is effectively self-documenting.

## Architectural Guidelines for Subfin

When working in Subfin's backend code, prefer these structures:

- **Routing layer (Express):**
  - Keep route definitions thin; delegate logic to controllers/services.
  - Group routes by domain or feature area.
  - Avoid inline anonymous handlers with lots of logic.

- **Controller / handler layer:**
  - Handle **request/response translation**: parse inputs, call services, map outputs.
  - Avoid accessing low-level infrastructure (DB, HTTP clients) directly if a service exists.
  - Keep controllers small; push complex branching and orchestration to services.

- **Service / domain layer:**
  - Encapsulate business rules and orchestration.
  - Prefer **pure functions** where possible; isolate side effects.
  - Share reusable logic across controllers via services rather than copy-paste.

- **Utility and helper layer:**
  - Extract cross-cutting helpers (validation, parsing, formatting, logging, error helpers).
  - Keep utilities focused and composable.
  - Avoid over-abstracting; only extract helpers when they clarify intent or remove real duplication.

## TypeScript Best Practices

When editing TypeScript code in Subfin:

- **Types as contracts**
  - Prefer explicit types for public functions, exported modules, and key data structures.
  - Represent domain concepts with **interfaces** or **type aliases** (e.g., `Track`, `Playlist`, `UserContext`).
  - Use enums or string unions for fixed sets of values instead of plain strings.

- **Avoid `any`**
  - Replace `any` with accurate types where feasible.
  - If a precise type is unknown, prefer `unknown` and narrow it, or well-documented unions.

- **Leverage utility and helper types**
  - Use built-in utilities (`Pick`, `Omit`, `Partial`, etc.) to avoid repeating shape definitions.
  - Reuse shared types across routes, controllers, and services to keep request/response shapes consistent.

- **Error handling types**
  - Model error shapes where they cross boundaries (e.g., service error results vs thrown errors).
  - Prefer clear, typed error helpers over ad-hoc string-based errors.

## Express and Middleware Patterns

For Express-specific logic in Subfin:

- Centralize **common middleware** (auth, logging, validation, error handling) and reuse across routes.
- Normalize response patterns (status codes, JSON envelopes) and apply consistently.
- Use async/await consistently and ensure errors bubble to a centralized error handler instead of scattered `try/catch` blocks everywhere.

When adding or refactoring middleware:

- Keep each middleware **focused on a single responsibility**.
- Ensure middleware is **composable** and order-sensitive behavior is intentional and documented in code structure and naming.

## DRY and Reusable Functionality

When you see duplication:

1. **Confirm real duplication**
   - Make sure duplicated code really represents the same concern and not subtly different cases.
2. **Extract a shared abstraction**
   - Choose a good home (utility module, service, or helper).
   - Give the abstraction a clear, intention-revealing name.
3. **Update all call sites**
   - Replace duplicated logic with calls to the new function/service.
   - Keep the function signature small and focused; do not overload it with unrelated options.

Prefer:

- Small, composable functions over monolithic ones.
- Clear, descriptive names over comments explaining unclear code.
- Stable, documented (via types and naming) interfaces between modules.

## Efficiency and Performance

When improving performance:

- First, target **obvious inefficiencies**:
  - Redundant I/O or HTTP requests
  - Repeated expensive computations that can be cached or memoized
  - Unnecessary serialization/deserialization
- Only introduce caching or complex optimizations when:
  - There is a realistic performance concern, and
  - The behavior remains correct and consistent with existing expectations.

Always:

- Prefer clarity over micro-optimizations unless the code is on a proven hot path.
- Document performance-sensitive paths with **clear naming and structure** rather than heavy comments.

## Working Style Under This Skill

When this skill is active, the agent should:

- Clearly state the **refactor goals** and the **parts of the codebase** being modified.
- Make changes in **coherent batches** (per feature or module) rather than sweeping edits across the entire codebase at once.
- Use the project's existing patterns and conventions as the **primary source of truth** for style and structure.
- Favor code that is easy for future maintainers to read and extend, even if it is slightly more verbose.


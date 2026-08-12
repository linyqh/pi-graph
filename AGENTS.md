# Repository Guidelines

## Project Structure & Module Organization

- `extensions/graph-engine/` contains the pi extension, graph runtime, process bridge, shared types, and reusable node factories.
- `graphs/` contains graph definitions and the registry. Add new graphs as focused modules and register them in `graphs/index.ts`.
- `README.md` documents local installation and the available `/graph*` commands. `tsconfig.json` is the source of truth for TypeScript checks.
- `tests/` contains the Node.js test suite for graph compilation, runtime behavior, storage, resources, and Pi integration boundaries. There is no checked-in asset directory yet.

## Build, Test, and Development Commands

This package has no build step. Use the checked-in npm scripts and Pi smoke commands from the repository root:

```bash
npm ci                  # Install the pinned development dependencies
npm run typecheck       # Type-check extensions and graph modules
npm test                # Run the Node.js test suite
npm run check           # Run type-checking and tests together
pi install "$PWD"      # Install/update the local pi package
/reload                 # Run inside pi after editing
/graph-list             # Smoke-test graph registration
/graph research "..."   # Exercise the built-in research graph
```

Peer dependencies are supplied by the pi environment. If `tsc` cannot resolve them, run the check from an environment with the pi package dependencies installed.

## Coding Style & Naming Conventions

Use strict TypeScript with ES2022/NodeNext modules and explicit `.ts` import extensions. Match existing formatting: tabs for indentation, double-quoted strings, semicolons, and trailing commas in multiline literals. Use `camelCase` for functions/variables, `PascalCase` for types, and descriptive lower-case graph/node IDs (for example, `approve_plan`). Prefer existing node factories and shared types over new abstractions.

## Testing Guidelines

The automated suite uses Node.js `node:test`; no coverage threshold is configured. Every change should at minimum pass `npm run check` and a focused Pi smoke test. For runtime or node changes, exercise success, failure, and approval paths where practical; record any manual-only verification in the pull request.

## Commit & Pull Request Guidelines

Follow the existing Chinese commit convention: write an imperative intent line describing why the change is needed, then include a short rationale and relevant Lore trailers such as `Constraint:`, `Confidence:`, `Tested:`, and `Not-tested:`. Pull requests should explain behavior and scope, link the issue or task when one exists, list verification commands and results, and include pi/TUI output or screenshots when the user-facing behavior changes.

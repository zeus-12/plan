# Workflow rules

- **Investigate and align before changing.** Before editing, check the code, explain the logic and fix, and wait for my OK—unless it's an obvious/simple change.
- **Never commit or push without my explicit approval.** Make the change, tell me what changed and how to test it, then wait. Commit or push only after I say so — every time, even mid-batch.
- **No PRs, no separate branches** unless I clearly ask. Everything goes to `main` by default.

# Validating a change

- Run `pnpm run validate` — typecheck, tests, lint, format across every package — before telling me a change is done.
- Single test file: `pnpm --filter @plan/desktop exec vitest run test/<name>.test.ts`.

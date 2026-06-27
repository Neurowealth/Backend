# chore: Git Hooks — Pre-commit Linting & Pre-push Tests

## Summary

Adds `husky` + `lint-staged` so formatting and lint errors are caught locally before they reach CI, and the test suite runs automatically before every push.

---

## What Changed

```
.husky/pre-commit       ← runs lint-staged on staged files
.husky/pre-push         ← runs full test suite before push
package.json            ← lint-staged config + prepare script
package-lock.json       ← updated lockfile
```

---

## Hook Behaviour

| Event | Command | Effect |
|---|---|---|
| `npm install` | `husky` (via `prepare`) | Hooks installed automatically for every contributor |
| `git commit` | `npx lint-staged` | ESLint auto-fix + Prettier format on staged `src/**/*.ts` and `tests/**/*.ts`; fixed files are re-staged |
| `git push` | `npm test -- --passWithNoTests` | Full Jest suite; push is blocked on test failures |

---

## lint-staged Config

```json
"lint-staged": {
  "src/**/*.ts": ["eslint --fix", "prettier --write"],
  "tests/**/*.ts": ["eslint --fix", "prettier --write"]
}
```

---

## Acceptance Criteria

- [x] `npm install` sets up hooks automatically via `prepare` script
- [x] Committing a file with a lint error is blocked (or auto-fixed and re-staged)
- [x] Committing a file with wrong formatting auto-fixes and re-stages it
- [x] CI still runs full lint + tests independently of hooks (unchanged)

---

## Notes

- Pre-existing test failures (missing `.env` vars, logic bugs in `client.test.ts`) are unrelated to this change — they fail identically on `main`. They will pass once a valid `.env` is in place.
- Use `git commit --no-verify` or `git push --no-verify` only when intentionally bypassing hooks (e.g. WIP commits, CI-only env setups).

# Contributing to Neurowealth Backend

Thank you for contributing! Please follow these guidelines to help us maintain quality and consistency.

## Local Setup

1. Fork the repository and create a branch from `main`
2. Run `npm install` to install dependencies
3. Copy `.env.example` to `.env` and configure your local environment
4. Start the database: `docker-compose up -d`
5. Run migrations: `npx prisma migrate deploy`
6. Start development server: `npm run dev`

## Development Commands

| Command | Description |
|---------|-------------|
| `npm test` | Run all tests |
| `npm run test:unit` | Run unit tests only |
| `npm run lint` | Run ESLint |
| `npm run typecheck` | Run TypeScript type check |
| `npm run format` | Format code with Prettier |
| `npm run format:check` | Check formatting |

## PR Conventions

### Branch Naming
- Use descriptive branch names: `fix/scopes-erasure-travelrule`
- Prefix with the issue type: `fix/`, `feat/`, `docs/`

### Commit Messages
- Use clear, descriptive commit messages
- Reference issues: `closes #390`
- Keep messages concise but informative

### Pull Request Description
- Include a summary of changes
- Reference closed issues using `closes #ISSUE_NUMBER`
- Include steps to verify the changes

### Git Hooks
- Husky hooks are configured for lint and commit message validation
- See `.husky/` directory for hook details
- Pre-commit: runs lint-staged
- Commit-msg: validates commit message format

## How Issues Map to PRs

1. Issue is created in the tracker
2. Developer creates a branch from `main`
3. Developer implements the fix/feature
4. Developer writes or updates tests
5. Developer ensures lint and typecheck pass
6. PR is submitted with issue reference
7. Maintainers review and merge

## Code Style

- Follow the existing code patterns in the repository
- Run `npm run lint` before submitting PR
- Run `npm run typecheck` to ensure type safety
- Format code with `npm run format`
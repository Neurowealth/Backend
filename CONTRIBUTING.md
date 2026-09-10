# Contributing to NeuroWealth Backend

Thank you for your interest in contributing! This guide will help you get started.

## Table of Contents

- [Getting Started](#getting-started)
- [Development Setup](#development-setup)
- [Development Workflow](#development-workflow)
- [Code Standards](#code-standards)
- [Pull Request Process](#pull-request-process)
- [Issue Guidelines](#issue-guidelines)

## Getting Started

1. **Fork** the repository
2. **Clone** your fork: `git clone https://github.com/YOUR_USERNAME/Backend.git`
3. **Add upstream**: `git remote add upstream https://github.com/Neurowealth/Backend.git`
4. **Create a branch**: `git checkout -b feat/your-feature-name`

## Development Setup

### Prerequisites

- Node.js 22+ 
- PostgreSQL 14+
- Docker & Docker Compose
- npm 9+

### Installation

```bash
# Install dependencies
npm install

# Set up environment
cp .env.example .env
# Edit .env with your configuration

# Start database
docker-compose up -d

# Run migrations
npx prisma migrate deploy

# Generate Prisma client
npx prisma generate

# Start development server
npm run dev
```

## Development Workflow

### Branch Naming

Use descriptive branch names with a prefix:

| Prefix | Use Case |
|--------|----------|
| `feat/` | New features |
| `fix/` | Bug fixes |
| `docs/` | Documentation updates |
| `refactor/` | Code refactoring |
| `test/` | Adding/updating tests |
| `chore/` | Maintenance tasks |

Examples:
- `feat/add-dca-endpoint`
- `fix/api-key-scope-enforcement`
- `docs/update-deployment-guide`

### Commit Messages

Use clear, descriptive commit messages:

```
feat: add DCA endpoint for recurring investments

- Add POST /api/goals/dca endpoint
- Add Zod validation for DCA parameters
- Add unit tests for DCA logic

Closes #123
```

### Running Tests

```bash
npm test                    # Run all tests
npm run test:unit           # Unit tests only
npm run test:integration    # Integration tests only
npm run test:coverage       # With coverage report
```

### Code Quality

```bash
npm run lint                # Check for lint errors
npm run lint -- --fix       # Auto-fix lint errors
npm run typecheck           # Type check
npm run format              # Format code
npm run format:check        # Check formatting
```

**All checks must pass before submitting a PR:**
```bash
npm run lint && npm run typecheck && npm test
```

## Code Standards

- **TypeScript**: Strict mode enabled, no `any` types
- **Formatting**: Prettier with default settings
- **Linting**: ESLint with TypeScript plugin
- **Imports**: Use absolute imports from `src/`
- **Error Handling**: Use proper error types, not raw strings
- **Validation**: Use Zod schemas for all request validation
- **Testing**: Write unit tests for new functions, integration tests for new endpoints

## Pull Request Process

1. **Ensure quality**: Run `npm run lint && npm run typecheck && npm test`
2. **Update documentation**: If adding/changing features, update relevant docs
3. **Write a clear PR description**: Explain what changed and why
4. **Reference issues**: Use `Closes #ISSUE_NUMBER` to link issues
5. **Request review**: Tag maintainers for review
6. **Respond to feedback**: Address review comments promptly

### PR Checklist

- [ ] Code follows existing style
- [ ] `npm run lint` passes
- [ ] `npm run typecheck` passes
- [ ] All tests pass
- [ ] New tests added (if applicable)
- [ ] Documentation updated (if applicable)
- [ ] No console.log or debug code left
- [ ] No secrets or credentials committed

## Issue Guidelines

### Reporting Bugs

Use the **Bug Report** template. Include:
- Steps to reproduce
- Expected vs actual behavior
- Environment details
- Error messages/logs

### Requesting Features

Use the **Feature Request** template. Include:
- Problem statement
- Proposed solution
- Alternatives considered

### Good First Issues

Look for issues labeled `good first issue` - these are beginner-friendly tasks perfect for first-time contributors.

## Need Help?

- Check existing [documentation](docs/)
- Open a [discussion](https://github.com/Neurowealth/Backend/discussions)
- Comment on the issue you're interested in

Thank you for contributing to NeuroWealth! 🚀

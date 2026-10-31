---
name: commit
description: 'Stage and commit changes with conventional commit format; use when "commit", "commit this", "stage and commit", or "make a commit".'
---

Stage and commit changes with conventional commit format.
Match repository's commit style.

# Git Commit Quick Reference

## Format

```
<type>(<scope>): <description>
```

## Common Types

- `feat` - New feature
- `fix` - Bug fix
- `docs` - Documentation
- `refactor` - Code restructuring
- `perf` - Performance improvement
- `test` - Testing
- `chore` - Maintenance

## Common Scopes

### Services

- `api` - Main API service
- `frontend` - Frontend application
- `common` - Shared package
- `docker` - Docker configs

### API Modules

- `api/symbols` - Symbol management
- `api/orders` - Order management
- `api/accounts` - Account management
- `api/liquidity` - Liquidity providers
- `api/auth` - Authentication

### Common Modules

- `common/dto` - Data Transfer Objects
- `common/prisma` - Database schema
- `common/utils` - Utility functions

## Examples

### ✅ Good

```bash
feat(api/symbols): add LP ticker formatting
fix(common/prisma): resolve FK constraint
docs(api): update OpenAPI specs
refactor(frontend/components): extract symbol selector
perf(quotes): optimize data processing
```

### ❌ Bad

```bash
fix stuff
Update files
new feature
WIP: symbols
Fixed the bug
```

## Breaking Changes

Add `!` after scope:

```bash
feat(api/symbols)!: restructure response format

BREAKING CHANGE: Symbol responses now include new fields.
Migration: Use response.fullTicker instead of response.displayTicker
```

## Multi-Service Changes

```bash
feat(*): implement unified error handling
refactor(api,frontend): standardize auth flow
```

## Tips

- Keep description under 72 characters
- Use imperative mood ("add" not "added")
- No period at end of description
- Include body for complex changes
- Reference issues: `Closes #123`

# Episodic Memory - Fork Maintenance Guide

This repository is a **fork** of [obra/episodic-memory](https://github.com/obra/episodic-memory).

## Git Workflow

### Branch Structure
- `main` - Local development branch with fork-specific changes
- `episodic-memory-dev` - Published branch for testing via Claude plugin marketplace
- Upstream `main` - The original obra/episodic-memory repository

### Commit Strategy

**Keep fork commits minimal and rebased on top of upstream:**

1. Fork-specific changes should be kept as few, well-organized commits
2. When upstream changes, rebase fork commits on top (not merge)
3. Use `git push --force` to `episodic-memory-dev` after rebasing

### Syncing with Upstream

```bash
# Add upstream remote (one-time)
git remote add upstream https://github.com/obra/episodic-memory.git

# Fetch upstream changes
git fetch upstream

# Rebase fork commits on top of upstream
git rebase upstream/main

# Force push to dev branch
git push origin main:episodic-memory-dev --force
```

### Current Fork Changes

The fork maintains these additional features on top of upstream:

#### 1. PostgreSQL/pgvector Support

Alternative database backend for shared/containerized deployments where SQLite file-based storage isn't practical.

**Configuration:**
```bash
export EPISODIC_MEMORY_DB_PROVIDER=postgresql
export EPISODIC_MEMORY_POSTGRES_URL=postgresql://user:pass@host:5432/dbname
```

**Features:**
- Uses pgvector extension for vector similarity search (HNSW index)
- Stateless sync - no local archive directory needed, sync state stored in DB
- Summaries stored in PostgreSQL instead of `-summary.txt` files
- Migration command: `episodic-memory migrate` to migrate from SQLite

**Files changed:**
- `src/config.ts` - Database configuration
- `src/db-provider.ts` - Abstract provider interface
- `src/providers/postgres-provider.ts` - PostgreSQL implementation
- `src/providers/sqlite-provider.ts` - SQLite implementation (refactored)
- `src/sync.ts` - Stateless sync support for PostgreSQL
- `src/migrate.ts` - SQLite to PostgreSQL migration

#### 2. Days Filter (`-d` / `--days`)

Filter the index command to only process conversations modified within the last N days.

**Usage:**
```bash
# Index only conversations from the last 7 days
episodic-memory index -d 7

# Combine with other flags
episodic-memory index -d 30 --no-summaries -c 4
```

**Files changed:**
- `src/index-cli.ts` - CLI argument parsing
- `src/indexer.ts` - `isWithinDaysLimit()` filter function

### When Making Changes

- Squash related changes into logical commits
- Keep commit messages descriptive for easy rebasing
- Avoid unnecessary changes that could conflict with upstream
- Test changes work with both SQLite (upstream default) and PostgreSQL

### Plugin Marketplace

This fork is published to the Claude plugin marketplace under:
- Marketplace: `danielsiwiec/episodic-memory`
- Branch: `episodic-memory-dev`

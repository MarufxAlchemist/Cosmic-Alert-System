# AI Agent Operating Rules — Transient Event Detection

## Primary Rule

Never use the entire repository as the primary source of context.
Always rely on `docs/` documentation first. Inspect source files only when required.

## Context Loading Order

Before starting any task, follow this exact order:

1. Read `docs/PROJECT_CONTEXT.md`
2. Read `docs/CURRENT_STATE.md`
3. Read `docs/ARCHITECTURE.md` — only if the task involves system design or multiple services
4. Read `docs/API_REFERENCE.md` — only if API-related work is required
5. Read `docs/DATABASE.md` — only if database modifications are involved
6. Read only the source files directly related to the requested task

Do NOT scan the entire repository unless absolutely necessary.

## Repository Scanning Policy

Only perform a repository-wide scan when:
- Explicitly requested by the user
- Documentation is outdated or inconsistent
- A dependency cannot be determined from the documentation
- Searching for a specific symbol, function, or file

Otherwise, inspect only the minimum number of files necessary.

## Documentation Responsibilities

After completing any development task, update the relevant docs:

### Update `docs/PROJECT_CONTEXT.md` when
- A major feature is added
- Repository structure changes
- Technologies are added or removed
- Project architecture changes significantly

### Update `docs/CURRENT_STATE.md` when
- Today's work is completed
- A feature changes status
- Bugs are fixed or discovered
- Milestones or priorities change

### Update `docs/ARCHITECTURE.md` when
- Data flow changes
- New services are introduced
- APIs communicate differently
- Authentication flow changes
- Deployment architecture changes

### Update `docs/DATABASE.md` when
- Schema changes
- Migrations are created
- Indexes are added
- Tables or relations change

### Update `docs/API_REFERENCE.md` when
- Endpoints change
- Request or response formats change
- Authentication changes
- WebSocket messages change

### Update `docs/CHANGELOG_AI.md`
Append a new entry after every completed work session.
Never rewrite previous entries. Always append.

## Documentation Editing Rules

- Never regenerate an entire document
- Modify only the affected sections
- Preserve formatting
- Avoid duplicate information
- Keep documentation concise

## Development Rules

- Only modify files directly related to the requested task
- Do not refactor unrelated code
- Do not rename files unless required
- Avoid introducing unnecessary dependencies
- Preserve existing project conventions

## Context Efficiency Rules

- Always minimize token usage
- Prefer documentation over source code
- Prefer targeted file reads over repository scans
- Never repeatedly inspect files already understood unless they have changed
- Reuse existing context whenever possible

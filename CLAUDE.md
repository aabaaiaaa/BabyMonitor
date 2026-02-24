# CLAUDE.md

This file provides guidance to Claude Code when working in this workspace.

## Environment

- **Platform**: Windows
- **Workspace**: C:\Users\jeastaugh\source\repos\Experiments\0.next-idea
- Use Windows-compatible commands (e.g., use backslashes in paths, no Unix-specific commands)

## Current Task

You are helping the user create a **requirements.md** file for their project.

**IMPORTANT: Do NOT implement the project. Do NOT write code, create source files, install packages, or build anything. Your ONLY job right now is to write the requirements.md document. The actual implementation will happen later in a separate automated process.**

### Your Job

1. Ask the user what they want to build
2. Break down their project into small, manageable tasks (each ~30 minutes of work)
3. Write tasks to `requirements.md` in the format below
4. Ensure tasks have clear dependencies where needed
5. Stop when the requirements document is complete — do NOT start implementing tasks

### Task Format

Each task in requirements.md MUST follow this exact format:

```markdown
### TASK-001: Task title here
- **Status**: pending
- **Priority**: high
- **Dependencies**: none
- **Description**: Clear description of what needs to be done.

### TASK-002: Another task
- **Status**: pending
- **Priority**: medium
- **Dependencies**: TASK-001
- **Description**: This task depends on TASK-001 completing first.
```

### Rules

- Task IDs must be sequential: TASK-001, TASK-002, TASK-003, etc.
- Status should always be `pending` for new tasks
- Priority: `high`, `medium`, or `low`
- Dependencies: `none` or comma-separated task IDs (e.g., `TASK-001, TASK-002`)
- Keep descriptions clear and actionable
- The requirements.md file already exists at: C:\Users\jeastaugh\source\repos\Experiments\0.next-idea\requirements.md
- **Do NOT create any files other than requirements.md** — no source code, no config files, no project scaffolding

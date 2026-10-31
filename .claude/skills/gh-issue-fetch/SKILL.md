---
name: github-issue-fetch
description: Fetch and display GitHub issue context from branch or number; use when task references a github issue.
---

# Issue Context

Fetch and display the GitHub issue associated with the current branch or a specific issue number.

## Usage

- `/github-issue-fetch` - Fetch issue based on current branch name (e.g., branch `511-feature` → issue #511)
- `/github-issue-fetch 123` - Fetch issue #123 directly

## Instructions

1. **Check if an argument was provided:**
   - If argument exists and is a number, use it as the issue number
   - If no argument, extract issue number from current branch name
2. Get the current branch name using `git branch --show-current` (if needed)
3. Extract the issue number from the branch name (e.g., `511-implement-feature` → `511`)
4. Use `gh issue view <number>` to fetch the issue details
5. Also fetch issue comments using `gh issue view <number> --comments`
6. Display the issue in a structured format

## Execution Steps

```bash
# If argument provided, use it directly
# Otherwise, get from branch name:

# Get current branch
BRANCH=$(git branch --show-current)

# Extract issue number (first number at the start of the branch name)
ISSUE_NUMBER=$(echo "$BRANCH" | grep -oE '^[0-9]+')

# If no issue number found, report it
if [ -z "$ISSUE_NUMBER" ]; then
  echo "No issue number found in branch name: $BRANCH"
  exit 1
fi

# Fetch issue details
gh issue view "$ISSUE_NUMBER"

# Fetch comments separately if needed
gh issue view "$ISSUE_NUMBER" --comments
```

## Output Format

Present the issue information as:

```
## Issue #<number>: <title>

**Status:** <state>
**Labels:** <labels>
**Assignees:** <assignees>
**Milestone:** <milestone>

### Description

<body>

### Comments

<comments if any>
```

## Error Handling

- If branch name doesn't start with a number, inform the user
- If issue doesn't exist, show the error from GitHub CLI
- If not in a git repository, inform the user

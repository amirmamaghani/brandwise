# Security policy

## Reporting a vulnerability

Please do **not** open a public issue. Use the repository's **Security** tab, "Report a vulnerability" (private vulnerability reporting). Include what you found, how to reproduce it and the impact.

We aim to acknowledge a report within 5 working days. This is a young project maintained in spare time, so fixes may take longer; we will keep you informed.

## Scope that matters most

- Anything that lets an agent or an outside caller publish without a human approval, or approve its own work.
- Exposure of credentials (provider keys, webhook secrets) to agents, logs or the UI.
- Webhook endpoints accepting unsigned or replayed requests.
- Path traversal or code execution in the video engine (Remotion projects run arbitrary code by design: they are trusted local code, not untrusted input).

## Supported versions

Only the latest commit on `main`. There are no releases yet.

## Hardening notes for operators

- The bb instance runs agents with a shell. Keep it on `127.0.0.1` or behind an authenticated tunnel; do not bind it to all interfaces.
- Expose only the webhook route to the internet (a tunnel for that single path), never the whole instance.
- Treat anything connected over MCP as fully trusted: it can run any bb command.

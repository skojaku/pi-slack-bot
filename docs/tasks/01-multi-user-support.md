# Multi-User Support

## Priority: High

## Problem
The bot only responds to a single user (`SLACK_USER_ID`). This makes it unusable for teams.

## Current Behavior
`slack.ts` checks `event.user !== config.slackUserId` and drops all other messages.

## Proposed Solution
- Replace `SLACK_USER_ID` with `SLACK_ALLOWED_USERS` — a comma-separated allowlist in `.env`
- Parse into a `Set<string>` in `config.ts`
- Update the guard in `slack.ts` to `!config.allowedUsers.has(event.user)`
- Per-user session isolation: prefix session keys with userId so threads from different users don't collide
- Add `!who` command showing who has active sessions

## Files to Change
- `src/config.ts` — new `allowedUsers: Set<string>` field
- `src/config.test.ts` — test parsing
- `src/slack.ts` — update user check
- `src/session-manager.ts` — consider per-user session limits
- `.env.example` — document new var

## Risks
- Session limit becomes per-user vs global — decide which
- Backward compat: keep supporting `SLACK_USER_ID` as a single-user shorthand

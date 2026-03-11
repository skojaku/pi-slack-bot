# Image/Vision Support for Uploaded Files

## Priority: Low

## Problem
When users upload images to a thread, they're saved to disk as files. Vision-capable models (Claude, GPT-4V) could analyze them directly, but the bot doesn't pass images as vision inputs.

## Current Behavior
- `file-sharing.ts` downloads all uploaded files to `.slack-files/` in the cwd
- `enrichPromptWithFiles()` prepends text context about the files
- Images are described by filename/mimetype but not sent as vision content

## Proposed Solution
1. Detect image files by mimetype (`image/png`, `image/jpeg`, `image/gif`, `image/webp`)
2. For image files, include them as base64-encoded image content in the prompt
3. Pi's `AgentSession.prompt()` likely supports multi-modal messages — check the SDK API
4. Fall back to file-save behavior for non-image files and when the model doesn't support vision
5. Support a size limit (e.g., skip images > 10MB)

## Files to Change
- `src/file-sharing.ts` — detect images, encode as base64
- `src/file-sharing.test.ts` — test image detection
- `src/slack.ts` — pass image content through to prompt
- `src/thread-session.ts` — use multi-modal prompt if available

## Risks
- Large images consume significant context tokens
- Not all models support vision — need model capability detection
- Base64 encoding doubles the size — check pi SDK for URL-based image support

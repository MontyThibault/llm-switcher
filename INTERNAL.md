# Internal System Documentation

This document captures the discovered storage patterns and CLI behaviors for the supported LLM tools.

## Gemini CLI
- **Base Directory:** `~/.gemini`
- **Project Mapping:** `~/.gemini/projects.json` maps absolute project paths to internal IDs.
- **Session Metadata:** `~/.gemini/tmp/<projectId>/logs.json` contains a list of session events, including `sessionId`, `timestamp`, and the first `user` message.
- **Transcripts:** `~/.gemini/tmp/<projectId>/chats/session-<timestamp>-<sessionId>.json` contains the full message history, including thoughts.
- **Resumption:** Uses `gemini --resume <index>`. The index must be parsed from the output of `gemini --list-sessions` by matching the UUID.

## Claude Code
- **Base Directory:** `~/.claude`
- **History Summary:** `~/.claude/history.jsonl` stores user prompts, timestamps, and session/project associations.
- **Transcripts:** Full conversation data is stored in `~/.claude/projects/<project-hash>/<sessionId>.jsonl`. These files use JSONL format where each line represents a message (`user`, `assistant`, `attachment`, etc.).
- **Resumption:** Uses `claude --resume <sessionId>`. Resumption is project-aware but benefits from being run in the original `cwd`.

## Codex CLI
- **Base Directory:** `~/.codex`
- **History Summary:** `~/.codex/history.jsonl` tracks user prompts and session IDs.
- **Transcripts:** Stored in `~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<sessionId>.jsonl`.
- **Metadata:** The first line of a rollout file is typically a `session_meta` event containing the `cwd` (working directory) where the session originated.
- **Resumption:** Uses `codex resume <sessionId>`. The `-C <dir>` flag is recommended to ensure the agent starts in the correct directory.

## Cross-Tool Migration Strategy
Since none of the tools currently support a native "import transcript" flag, migration is achieved by:
1. Extracting the text of all `user` and `assistant` messages from the source transcript.
2. Formatting them into a readable text block.
3. Launching the target tool with a synthesized initial prompt that includes this transcript as context.

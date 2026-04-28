# Internal System Documentation

This document captures the discovered storage patterns and CLI behaviors for the supported LLM tools.

## Gemini CLI
- **Base Directory:** `~/.gemini`
- **Project Mapping:** `~/.gemini/projects.json` maps absolute project paths to internal IDs.
- **Project Mapping Fallback:** `~/.gemini/tmp/<projectId>/.project_root` also stores the original absolute project path. This is useful because project IDs can be either hash-like strings or human-readable directory names.
- **Session Metadata:** `~/.gemini/tmp/<projectId>/logs.json` contains a list of session events, including `sessionId`, `timestamp`, and the first `user` message.
- **Transcripts:** `~/.gemini/tmp/<projectId>/chats/session-<timestamp>-<short-session-id>.json` contains the full message history, including thoughts and tool calls. The file also stores the full `sessionId`, so transcript lookup should read candidate JSON files and match `sessionId` exactly rather than relying on filename prefixes.
- **Transcript Content:** Visible user text is usually in `messages[].content[].text`; visible model text may be a string in `messages[].content`. `thoughts`, `toolCalls`, and `info` messages should not be included in migration transcripts.
- **Resumption:** Uses `gemini --resume <index>`. The index must be parsed from the output of `gemini --list-sessions` by matching the UUID.

## Claude Code
- **Base Directory:** `~/.claude`
- **History Summary:** `~/.claude/history.jsonl` stores user prompts, timestamps, and session/project associations.
- **Project Directories:** Project folders under `~/.claude/projects` encode absolute paths, e.g. `/Users/example/project` becomes `-Users-example-project`.
- **Transcripts:** Full conversation data is stored in `~/.claude/projects/<encoded-project-path>/<sessionId>.jsonl`. These files use JSONL format where each line represents a message (`user`, `assistant`, `attachment`, etc.).
- **Transcript Content:** Visible text is in `message.content` as either a string or an array of content blocks. Migration should include text blocks only and skip `thinking`, `tool_use`, `tool_result`, attachments, and snapshots.
- **Resumption:** Uses `claude --resume <sessionId>`. Resumption is project-aware but benefits from being run in the original `cwd`.

## Codex CLI
- **Base Directory:** `~/.codex`
- **History Summary:** `~/.codex/history.jsonl` tracks user prompts and session IDs.
- **Transcripts:** Stored in `~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<sessionId>.jsonl`.
- **Metadata:** The first line of a rollout file is typically a `session_meta` event containing the `cwd` (working directory) where the session originated.
- **Current Rollout Shape:** Recent rollout files include `response_item` records in addition to `event_msg` records. Visible user/assistant transcript text is in `response_item.payload` when `payload.type === "message"` and `payload.role` is `user` or `assistant`.
- **Transcript Content:** User messages use `content[].type === "input_text"` and assistant messages use `content[].type === "output_text"`. Internal context such as `<environment_context>`, developer messages, `turn_context`, and non-message events should not be included in migration transcripts.
- **Resumption:** Uses `codex resume <sessionId>`. The `-C <dir>` flag is recommended to ensure the agent starts in the correct directory.

## Cross-Tool Migration Strategy
Since none of the tools currently support a native "import transcript" flag, migration is achieved by:
1. Extracting the text of all `user` and `assistant` messages from the source transcript.
2. Formatting them into a readable text block.
3. Launching the target tool with a synthesized initial prompt that includes this transcript as context.

# ShadowGit MCP server

Gives Claude Code, Codex, Cursor and Claude Desktop access to [ShadowGit](https://shadowgit.com): the automatic snapshots
ShadowGit takes of your projects every few minutes, kept apart from your own git history. Your assistant can see what
changed and when, and can save its own edits as one snapshot with a title instead of many partial ones.

## Requirements

- Node.js 20 or later
- The ShadowGit app (0.3.4 or later for saved snapshots, a release after 0.3.5 for the Lens, after 0.3.7 for its
  linked words, after 0.3.9 for the map, after 0.3.10 for the Lens's dependency facts, 0.3.11 or later for the
  project's rules, 0.3.13 or later for a session's unsaved edits in a snapshot as it ends and for the check of a saved
  snapshot that finds nothing new, 0.4.0 or later for review comments and the docs pages of any change, a release
  after 0.4.0 for area ids and for where a session is reviewed, 0.7.0 or later for the project's outline, dependents'
  lines and the facts as your assistant reads and edits), tracking at least one project.
  Reading history works while the app is closed;
  sessions, saved snapshots, the Lens, the map and review comments need it running.
- Git on your PATH

## Setup

**Claude Code** (one install for every project):

```bash
claude mcp add --scope user shadowgit -- npx -y shadowgit-mcp-server
```

**Codex**:

```bash
codex mcp add shadowgit -- npx -y shadowgit-mcp-server
```

**Cursor**: in `~/.cursor/mcp.json`:

```json
{ "mcpServers": { "shadowgit": { "command": "npx", "args": ["-y", "shadowgit-mcp-server"] } } }
```

**Claude Desktop**: the same entry in `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or
`%APPDATA%\Claude\claude_desktop_config.json` (Windows).

In Claude Code the server knows which project you are in. In Cursor and Claude Desktop, name the project ("in
webshop") when ShadowGit tracks more than one.

## What to ask

- "Show me my ShadowGit projects"
- "What changed in the last hour?"
- "When did the login page break?"
- "Show me the history of Header.tsx"
- "How is this project organised?"
- "What depends on chargeCard?"
- "Start a ShadowGit session for this refactor", then "Save a snapshot named Fixed login redirect", then "End the
  ShadowGit session"
- "Write the Lens words for this session"
- "What does the billing area do?"
- "Document this project in ShadowGit"
- "Address my ShadowGit review comments"

## As your assistant reads and edits

With ShadowGit 0.7.0 or later, your assistant gets the map's facts at three moments, with no step of its own:

1. **As a session starts**, the project's outline is in the server's instructions: its areas, the heaviest links between
   them, its processes and its rules, in up to about 2,200 characters. The server reads it once, as it starts: with the
   app closed or the map not drawn yet, that session goes without it.
2. **After it reads a file** (Claude Code), when other areas use the file's code or a rule holds for it: the file's area
   and layer, which of its symbols other areas use, and those rules.
3. **After it edits a file** (Claude Code and Codex): what changed in the file since the conversation began, for each
   symbol something depends on. Where the change can break callers, its dependents come with the line where each uses
   the symbol, where the map has one; otherwise, how many depend on it and from where. A summary of up to about 2,000
   characters: at most six symbols and eight dependents each, and `get_code_context` lists the rest.

The first needs nothing. The dependents in `get_code_context`'s answer also come with the line where they use the code,
where the map has one, and in Claude Code the tool loads with the first prompt. The other two come through hooks in your assistant's settings
that call `facts_for_hooks`: turn them on in ShadowGit, beside your connected assistant in Get started or in Settings ›
Integrations, with "Show it the map as it reads and edits". They are off by default: a benchmark of 690 runs found no
help from them, slightly lower if anything (see the [CHANGELOG](CHANGELOG.md#2110---2026-11-15)). The facts come from
the map on your computer and go to your AI provider like any file your assistant reads. When there is nothing to say
(the app closed, a project ShadowGit doesn't track, a fact already said), your assistant gets nothing extra.

The hooks, as ShadowGit writes them, if you set them up by hand:

```jsonc
// Claude Code, ~/.claude/settings.json (Claude Code 2.1.118 or later)
{ "hooks": { "PostToolUse": [ { "matcher": "Read|Edit|Write", "hooks": [ {
  "type": "mcp_tool", "server": "shadowgit", "tool": "facts_for_hooks", "timeout": 5,
  "input": { "event": "${hook_event_name}", "tool": "${tool_name}", "file": "${tool_input.file_path}", "agent": "${agent_id}" }
} ] } ] } }

// Codex, ~/.codex/hooks.json (Codex 0.149.0 or later, which asks you to trust it at its next start)
{ "hooks": { "PostToolUse": [ { "matcher": "^apply_patch$", "hooks": [ {
  "type": "mcp_tool", "server": "shadowgit", "tool": "facts_for_hooks", "timeout": 5,
  "input": { "event": "${hook_event_name}", "tool": "${tool_name}", "patch": "${tool_input.command}" }
} ] } ] } }
```

The hooks sit in your user settings, so they run in every session. In one where the `shadowgit` server isn't connected
(it was removed, turned off in `/mcp`, or hasn't started yet), or when the app doesn't answer in time, Claude Code shows
a "hook error" notice and goes on. Turn
the hooks off in ShadowGit to remove them.

## Tools

| Tool | Does |
|---|---|
| `list_repos` | Lists tracked projects, the current one, their last snapshot and any active session |
| `git_command` | Runs a read-only git command (`log`, `diff`, `show`, `blame`, …) on the snapshot history |
| `get_map` | Gives how the project is organised: its areas, layers and the links between them, or one area, the project's rules and its docs pages' summaries |
| `get_code_context` | Gives where files and symbols sit, what depends on them, where a change to them lands, the project's rules for them and their areas' docs pages' summaries |
| `start_session` | Pauses automatic snapshots while the assistant edits |
| `checkpoint` | Saves the current changes as one snapshot with a title, following `.shadowgit-ignore`, then checks it against the project's `.shadowgit-rules` |
| `end_session` | Resumes automatic snapshots, and tells your assistant where you review the session in ShadowGit |
| `get_lens` | Reads ShadowGit's Lens of a change, by default your latest session, with what it makes depend on what and the links a rule names |
| `write_lens_words` | Writes the Lens's words for that change, kept in the history, with links, a why and an excerpt |
| `get_docs` | Reads the project's docs pages, one per map area plus an Overview: by default those your latest session changed that need words, each with its facts, its words so far and what changed since them |
| `write_docs` | Writes pages' words, with links to symbols and areas, or keeps words that still hold; kept in the history, never in the project's files |
| `get_review_comments` | Reads the review comments you sent from ShadowGit and haven't resolved, by Send, with their lines, words and replies |
| `reply_to_review_comment` | Replies to one comment: ShadowGit shows the reply under it, with the snapshot that holds the change |
| `facts_for_hooks` | Answers ShadowGit's hooks with the map's facts on the file your assistant just read or edited; for a direct question, `get_code_context` |

The other tools work on the current project unless given `repo`.

## Security

`git_command` runs only read-only subcommands, without a shell, and refuses the options that would read or write files
outside the snapshot history (`--output`, `--no-index`, `blame --contents` and others, including abbreviated and bundled
forms), the ones that run helper commands from git's configuration (`--ext-diff`, `--textconv`, `--filters`), and paths
outside the project. Saved snapshots are made by the ShadowGit app, only in projects you added to it. The
server itself only talks to the ShadowGit app on localhost; what it returns goes to your assistant like any tool result.

The server trusts the project's `.shadowgit.git` history, which the ShadowGit app creates. Git honours that history's
configuration, so a planted one can make git run programs, through the app's own snapshots as much as through this
server. Don't add a project to ShadowGit that arrived with a `.shadowgit.git` folder you didn't create.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `SHADOWGIT_TIMEOUT` | `10000` | Milliseconds a git command may run |
| `SHADOWGIT_SESSION_API` | `http://localhost:45289/api` | The ShadowGit app's local API |
| `SHADOWGIT_STORAGE_DIR` | platform default | Where ShadowGit keeps `repos.json` |

## Development

```bash
npm install
npm test        # builds, then runs the unit, integration and end-to-end tests
npm run eval    # runs the phrases from docs.shadowgit.com through Claude Code (spends tokens)
```

## License

MIT

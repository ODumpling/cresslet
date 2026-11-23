# Live Link: drive a Studio project from a desktop agent

`cresslet connect` lets a desktop coding agent (Claude Code, Codex, T3 Code) build an app that's open in Cresslet Studio. The agent edits the project's files and runs commands inside your browser tab, and the preview updates as it works. No files are copied out of the browser.

```
agent ──stdio MCP──> cresslet connect ──WebSocket──> Cresslet server ──WebSocket──> your Studio tab ──> project
```

`cresslet connect` is an MCP server, not a command to run yourself. The agent starts it, and only that agent can use it. If you run it in your own terminal and pair the tab with it, your agent still can't reach the project.

## What the agent gets

The same tools as the Studio's built-in AI builder, acting on the open project:

| Tool | Does |
| --- | --- |
| `list_files`, `read_file` | read the project's files |
| `write_file`, `edit_file`, `delete_file` | change them (paths are project-relative; local secrets such as `.env*`, `.envrc` and `.dev.vars` are off limits) |
| `run_command` | run a command in the in-browser shell: `npm`, `node`, `cresslet build`, and the like (stopped after 120 s) |
| `read_dev_log` | read the dev server's output (build errors, server logs) |
| `commit_change(title)` | end a turn: on an app linked to GitHub, commits the changes as a [stack change](architecture.md#stacked-changes) |

Each call shows up live in the AI builder pane. It doesn't need an Anthropic key or AI credits, because the agent brings its own model.

## Set up

1. Install the CLI and log in: `npm i -g cresslet`, then `cresslet login`.
2. Register `cresslet connect` with your agent. `--agent` is the name the Studio shows when it asks you to allow the connection.

   Claude Code:

   ```sh
   claude mcp add -s user cresslet -- cresslet connect --agent "Claude Code"
   ```

   Codex (`~/.codex/config.toml`):

   ```toml
   [mcp_servers.cresslet]
   command = "cresslet"
   args = ["connect", "--agent", "Codex"]
   ```

   T3 Code uses the MCP servers configured for its provider (Claude Code or Codex), so set it up there.

   Without a global install, use `npx cresslet connect` as the command.

## Pair and build

1. Open the project in Cresslet Studio, logged in to the same account as the CLI.
2. Ask the agent for a change, for example "add a dark mode toggle".
3. The agent's first tool call returns a pairing code (`XXXX-XXXX`), and the agent should pass it on to you.
4. In the **Build with Claude** pane, click the link icon (**Connect desktop agent**), enter the code and click **Connect**.
5. Check the name in "*agent* wants to control *project*" and click **Allow**.
6. The agent retries and gets to work. Watch the preview, and click **Disconnect** (in the builder banner or the top bar) to stop it at any time.

Deploys still need you: when the agent runs `cresslet deploy`, the tab asks you to **Approve deploy**.

## Good to know

- **Pairing is lazy.** No code is requested until the agent's first tool call. `--eager` pairs as soon as the agent starts `cresslet connect`, but the code then appears only on its stderr, which most agents don't show you.
- **One agent session, one tab.** A code expires after 5 minutes. Restarting the agent, closing or reloading the tab, or clicking Disconnect ends the pairing, and the next tool call gets a new code. Sessions also end after 1 hour idle or 12 hours in all.
- **Same account only.** The tab and the CLI must be logged in as the same account. The CLI's token must be account-wide (`deploy` or `admin`), so `read` tokens, app-scoped tokens and deploy keys don't work.
- **What you're allowing.** `run_command` runs in the project's in-browser shell, so pairing gives the agent the same access to that project as the built-in AI builder: files and commands, but not your other projects or the Studio's storage.
- **Self-hosted servers** keep pairings in memory on one process, so the relay doesn't work across several server nodes ([architecture](architecture.md#live-link-cresslet-connect)).

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| The agent doesn't list the `cresslet` tools | Check it's registered (`claude mcp list`) and restart the agent session. |
| The `cresslet` server fails to start, or the token is refused | Run `cresslet login`. If `CRESSLET_TOKEN` is set, it must be an account-wide `deploy` or `admin` token. |
| The code isn't accepted | It expired or belongs to another account. Ask the agent to call any tool again to get a new one. |
| The **Connect desktop agent** button is greyed out | Log in to the Studio, and wait until the AI builder has finished its current turn. |

# Live Link: drive a Studio project from a desktop agent

`cresslet connect` lets a desktop coding agent (Claude Code, Codex, T3 Code, Cursor, VS Code) build an app that's open in Cresslet Studio. The agent edits the project's files and runs commands inside your browser tab, and the preview updates as it works. No files are copied out of the browser.

```
agent ──stdio MCP──> cresslet connect ──WebSocket──> Cresslet server ──WebSocket──> your Studio tab ──> project
```

`cresslet connect` is an MCP server, not a command to run yourself. The agent starts it, and only that agent can use it. If you run it in your own terminal and pair the tab with it, your agent still can't reach the project.

You pair an agent once with a code and tick **Remember this agent**. After that it reconnects on its own: across agent restarts, dropped connections, tab reloads and server restarts, with no code, to the projects you allowed.

## What the agent gets

The same tools as the Studio's built-in AI builder, acting on the open project:

| Tool | Does |
| --- | --- |
| `list_files`, `read_file` | read the project's files |
| `write_file`, `edit_file`, `delete_file` | change them (paths are project-relative; local secrets such as `.env*`, `.envrc` and `.dev.vars` are off limits) |
| `run_command` | run a command in the in-browser shell: `npm`, `node`, `cresslet build`, and the like (stopped after 120 s) |
| `read_dev_log` | read the dev server's output (build errors, server logs) |
| `commit_change(title)` | end a turn: on an app linked to GitHub, commits the changes as a [stack change](architecture.md#stacked-changes) |

A remembered agent also gets three tools for choosing the project:

| Tool | Does |
| --- | --- |
| `list_projects` | the projects you allowed it in that are open now (a handle and a name each, and whether one is in use) |
| `use_project(handle)` | work on one of them. Switching away from the current one needs your click in that project's tab |
| `confirm_project(ack)` | confirm a project it picked by itself (see [Which project](#which-project)) |

Each call shows up live in the AI builder pane. It doesn't need an Anthropic key or AI credits, because the agent brings its own model.

## Set up

1. Install the CLI and log in: `npm i -g cresslet`, then `cresslet login`.
2. Register `cresslet connect` with your agent, as below. `--agent` is the name the Studio shows when it asks you to allow the connection.

### Claude Code

```sh
claude mcp add -s user cresslet -- cresslet connect --agent "Claude Code"
```

### Codex

`~/.codex/config.toml` (Windows: `%USERPROFILE%\.codex\config.toml`):

```toml
[mcp_servers.cresslet]
command = "cresslet"
args = ["connect", "--agent", "Codex"]
```

### T3 Code

T3 Code uses the MCP servers configured for its provider (Claude Code or Codex), so set it up there.

### Cursor

`~/.cursor/mcp.json` (Windows: `%USERPROFILE%\.cursor\mcp.json`), or `.cursor/mcp.json` in a project:

```json
{
  "mcpServers": {
    "cresslet": { "command": "cresslet", "args": ["connect", "--agent", "Cursor"] }
  }
}
```

### VS Code

`.vscode/mcp.json` in a workspace, or **MCP: Open User Configuration** for every workspace:

```json
{
  "servers": {
    "cresslet": { "type": "stdio", "command": "cresslet", "args": ["connect", "--agent", "VS Code"] }
  }
}
```

### When the agent can't find `cresslet`

Apps started from the dock or Start menu often don't get your shell's `PATH`, so `cresslet` (or `node`) isn't found. Give the absolute paths instead: the command is Node itself, and the first argument is the CLI's script.

Find them:

| | Node | The CLI's script |
| --- | --- | --- |
| macOS, Linux | `which node` | `echo "$(npm root -g)/cresslet/dist/bin/cresslet.js"` |
| Windows (PowerShell) | `(Get-Command node).Source` | `"$(npm root -g)\cresslet\dist\bin\cresslet.js"` |

macOS / Linux, for example (Cursor's format; the others take the same `command` and `args`):

```json
{
  "mcpServers": {
    "cresslet": {
      "command": "/opt/homebrew/bin/node",
      "args": ["/opt/homebrew/lib/node_modules/cresslet/dist/bin/cresslet.js", "connect", "--agent", "Cursor"]
    }
  }
}
```

Windows (backslashes doubled in JSON):

```json
{
  "mcpServers": {
    "cresslet": {
      "command": "C:\\Program Files\\nodejs\\node.exe",
      "args": ["C:\\Users\\you\\AppData\\Roaming\\npm\\node_modules\\cresslet\\dist\\bin\\cresslet.js", "connect", "--agent", "Cursor"]
    }
  }
}
```

The same in Codex's TOML (single quotes keep backslashes as they are):

```toml
[mcp_servers.cresslet]
command = 'C:\Program Files\nodejs\node.exe'
args = ['C:\Users\you\AppData\Roaming\npm\node_modules\cresslet\dist\bin\cresslet.js', 'connect', '--agent', 'Codex']
```

And for Claude Code: `claude mcp add -s user cresslet -- "<node>" "<script>" connect --agent "Claude Code"`.

Without a global install, `npx cresslet connect` works as the command where `npx` is on the agent's `PATH` (on Windows: command `cmd`, args `["/c", "npx", "cresslet", "connect"]`).

## Pair once

1. Open the project in Cresslet Studio, logged in to the same account as the CLI.
2. Ask the agent for a change, for example "add a dark mode toggle".
3. The agent's first tool call returns a pairing code (`XXXX-XXXX`), and the agent should pass it on to you.
4. In the **Build with Claude** pane, click the link icon (**Connect desktop agent**), enter the code and click **Connect**.
5. Check the name in "*agent* wants to control *project*", tick **Remember this agent**, and click **Allow**.
6. The agent retries and gets to work.

Left unticked, Allow works as before Remember existed: that one agent session, in that one tab, until either closes.

Deploys still need you: when the agent runs `cresslet deploy`, the tab asks you to **Approve deploy**.

## After that

- **Restarts and reloads.** Restart the agent, reload the tab, or let the server restart: the agent reconnects by itself (backing off from 1 s to 30 s between tries) and carries on with the same project. A call that was running when the connection dropped is reported as "outcome unknown" and never run twice: the agent should check before trying again. Calls it hadn't sent yet wait up to 15 s for the connection to come back.
- **Another project.** Open it and click **Connect desktop agent**: your remembered agents are listed there with **Allow** (no code). Only you can allow a project, from its tab: nothing the agent sends can.
- **Several projects open.** A new agent session with more than one allowed project open gets `list_projects` instead of a guess, and picks one with `use_project`. Writes land only in the project it picked.
- **Switching.** When the agent asks to move to another allowed project, that project's tab shows **Use with *agent***. Until you click it, the agent keeps working on the current one; the request lapses after 5 minutes, or when that tab closes, and the agent can withdraw it. Both tabs say when it switched.
- **Closed tab.** If the agent's project isn't open, its calls fail with "Project *name* isn't open in Studio" and a link to it (it opens in the browser that allowed it). The agent is never moved to another project instead.

### Which project

The agent remembers the project it last used in each folder. When it picks a project by itself (that remembered one after a restart, or the only allowed project open), its first tool call doesn't run: it answers "Connected to project *name*. If that's the project you meant, call `confirm_project(…)`". The agent should tell you which project that is and confirm only if it's the right one. Until it does, nothing runs. A project it chose itself with `use_project`, or one you just allowed, needs no confirming.

## Stop an agent

| | Does | Undo |
| --- | --- | --- |
| **Disconnect** (builder banner or top bar) | stops the agent at once (its running call is cancelled) and keeps this project disconnected, across reloads, until you click **Resume**. Calls it queued before don't run after Resume | **Resume** |
| **Take over** | another agent wants a project one is using: the tab offers to hand it over | |
| **Forget agent** (banner, or Settings → **Connected agents**) | revokes the agent: its connections close and it needs a pairing code again, for every project | pair again |
| `cresslet logout` | revokes the agents remembered with that login and deletes their files; revokes the login's token too if `cresslet login` created it (a token you gave it with `--token` stays valid). It never touches `CRESSLET_TOKEN` | `cresslet login`, pair again |
| Revoke the CLI's token (Settings → **API tokens**) | revokes the agents remembered with it | |

A remembered agent unused for 90 days needs a code again.

## Good to know

- **One agent per project.** While one agent works on a project, another gets "Project in use by *agent*", and the tab offers **Take over**. An agent and the built-in Claude never run in a project at the same time.
- **One tab per project.** A project open in two tabs runs in one of them; the other shows it read-only ("Open in another tab") and takes over when the first closes. Agents reach the tab that runs it.
- **What remembering keeps.** The CLI keeps each remembered agent's secret in its own file, `~/.config/cresslet/agents/<id>.json` (`%USERPROFILE%\.config\cresslet\agents` on Windows; `CRESSLET_CONFIG_DIR` moves it), next to the login token and protected the same way. Reconnecting needs both the login token and that secret, so a leaked token alone (CI logs, shell history) can't reach your tabs. The server keeps only a hash of it. Your browser keeps its own secret (in the Studio's site storage) that proves it's the browser you allowed the agent in.
- **Pairing is lazy.** No code is requested until the agent's first tool call. `--eager` pairs as soon as the agent starts `cresslet connect`, but the code then appears only on its stderr, which most agents don't show you. A remembered agent connects as it starts.
- **Same account only.** The tab and the CLI must be logged in as the same account. The CLI's token must be account-wide (`deploy` or `admin`), so `read` tokens, app-scoped tokens and deploy keys don't work.
- **The server it talks to** is the one you logged in to (`cresslet login`, `--api`, `CRESSLET_API`), never one named in a project's `.cresslet/app.json`: a cloned repository can't send your token elsewhere.
- **What you're allowing.** `run_command` runs in the project's in-browser shell, so allowing an agent gives it the same access to that project as the built-in AI builder: files and commands, but not your other projects or the Studio's storage.
- **Self-hosted servers** keep connections in memory on one process, so the relay doesn't work across several server nodes ([architecture](architecture.md#live-link-cresslet-connect)).

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| The agent doesn't list the `cresslet` tools | Check it's registered (`claude mcp list`) and restart the agent session. If it says `cresslet` or `node` isn't found, use [absolute paths](#when-the-agent-cant-find-cresslet). |
| The `cresslet` server fails to start, or the token is refused | Run `cresslet login`. If `CRESSLET_TOKEN` is set, it must be an account-wide `deploy` or `admin` token. |
| The code isn't accepted | It expired or belongs to another account. Ask the agent to call any tool again to get a new one. |
| No **Remember this agent** checkbox | The CLI is older than Live Link v2 (`npm i -g cresslet`), or this browser blocks site storage. |
| The agent asks for a code again | It was forgotten, its token revoked or logged out, or it went unused for 90 days. Pair again. |
| "isn't open in Studio" | Open that project in the browser you allowed it in. |
| "Disconnected in Cresslet Studio" | Click **Resume** in the project's tab. |
| The **Connect desktop agent** button is greyed out | Log in to the Studio, and wait until the AI builder (or the connected agent) has finished. |

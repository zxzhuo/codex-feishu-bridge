# codex-feishu-bridge

Feishu/Lark bot bridge for the Codex CLI. It lets you drive Codex from Feishu, keep a persistent Codex session per chat/project, switch projects, abort long runs, and manage the Codex CLI services running on the bridge host from slash commands.

## Product shape

The bridge is designed around real remote-coding usage:

- **Chat as the control plane**: send a normal Feishu message to ask Codex to work.
- **One route = one session**: each `chatId + project` keeps its own Codex `thread_id` and resumes it automatically.
- **Projects are explicit**: `/project <name>` changes the working directory under `projectsBaseDir`.
- **Long tasks are visible**: replies are sent as Feishu interactive cards and updated in-place.
- **Codex CLI service management is explicit**: `/codex remote-start`, `/codex remote-stop`, `/codex doctor`, etc. are executed by the bridge host as local `codex` CLI commands; they are not sent into a Codex conversation.
- **Install should not be fragile**: config is created by `codex-feishu init`; secrets can stay in environment variables.

## Source

GitHub: https://github.com/zxzhuo/codex-feishu-bridge

```bash
git clone https://github.com/zxzhuo/codex-feishu-bridge.git
```

## Install

```bash
npm install -g codex-feishu-bridge
```

Or run without a global install:

```bash
npx codex-feishu-bridge init --app-id cli_xxx --app-secret-env FEISHU_APP_SECRET --owner-open-id ou_xxx
```

## One-command config

Recommended: do not write the Feishu secret into the config file. Keep it in an env var and let config reference it.

```bash
export FEISHU_APP_SECRET='your-secret'
codex-feishu init \
  --app-id cli_xxx \
  --app-secret-env FEISHU_APP_SECRET \
  --owner-open-id ou_xxx
```

By default Codex runs in your home directory (`~/`). To use another workspace/project root:

```bash
codex-feishu init \
  --app-id cli_xxx \
  --app-secret-env FEISHU_APP_SECRET \
  --owner-open-id ou_xxx \
  --workspace-dir ~/workplace/projects \
  --default-project .
```

This writes:

```text
~/.config/codex-feishu/config.json
```

Then run in background:

```bash
codex-feishu doctor
codex-feishu start
codex-feishu status
codex-feishu logs --lines 80
```

Foreground mode is also available for debugging:

```bash
codex-feishu run
```

Background process management:

```bash
codex-feishu start     # start bridge in background
codex-feishu stop      # stop background bridge
codex-feishu restart   # restart background bridge
codex-feishu status    # show pid/log paths
codex-feishu logs      # tail recent logs
```

The default work path is `~/` (`workspaceDir: "~"`, `defaultProject: "."`). You can override it in config, env, or per start/run command:

```bash
# one-time config at init
codex-feishu init --workspace-dir /path/to/projects --default-project . ...

# per process start
codex-feishu start --workspace-dir /path/to/projects
codex-feishu run --workspace-dir /path/to/projects

# env override
CODEX_FEISHU_WORKSPACE_DIR=/path/to/projects codex-feishu start
```

`--projects-dir` is kept as a backward-compatible alias of `--workspace-dir`.

## Feishu app requirements

In Feishu open platform:

1. Enable bot capability.
2. Event subscription: `im.message.receive_v1`.
3. Use **long connection / WebSocket** if `transport` is `ws`.
4. Permissions: `im:message`, `im:message:send_as_bot`, `im:chat`.
5. Publish the app.

Important: Feishu `open_id` is app-specific. Use the open_id from this app's actual message callback when configuring `allowedOpenIds`.

## CLI help behavior

`codex-feishu`, `codex-feishu help`, `codex-feishu --help`, and `codex-feishu -h` print this full README/help text.

If a command fails, the CLI first prints the error message, then prints this full README/help text so users can recover without searching docs.

## Slash commands

| Command | Action |
|---|---|
| `/help` | Show help |
| `/status` | Show active project, cwd, Codex session, state file |
| `/project` | List projects |
| `/project <name>` | Switch to an existing project; Unicode names such as Chinese are supported |
| `/project new <name>` | Create and switch project; Unicode names such as Chinese are supported |
| `/new` | Clear current project session; next message starts a new Codex session |
| `/sessions` | List recent Codex sessions recorded by the bridge |
| `/abort` | Stop current Codex process for this chat/project |
| `/codex remote-start` | Run `codex remote-control start` on the bridge host |
| `/codex remote-stop` | Run `codex remote-control stop` on the bridge host |
| `/codex daemon-start` | Run `codex app-server daemon start` on the bridge host |
| `/codex daemon-stop` | Run `codex app-server daemon stop` on the bridge host |
| `/codex doctor` | Run `codex doctor` on the bridge host |
| `/codex version` | Run `codex --version` on the bridge host |

Normal messages are sent to Codex. If a previous session exists for the current chat/project, the bridge runs:

```bash
codex exec resume <thread_id> --json <prompt>
```

Otherwise it runs:

```bash
codex exec --json -C <project_dir> <prompt>
```

## Config

Example config:

```json
{
  "appId": "cli_xxxxxxxxxxxx",
  "appSecret": "${FEISHU_APP_SECRET}",
  "transport": "ws",
  "allowedOpenIds": ["ou_replace_with_current_app_open_id"],
  "ownerOnly": true,
  "workspaceDir": "~",
  "stateDir": "~/.codex-feishu",
  "defaultProject": ".",
  "codexBin": "codex",
  "codexModel": "gpt-5.5",
  "codexSandbox": "workspace-write",
  "codexApproval": "never",
  "skipGitRepoCheck": true,
  "promptTimeoutMs": 0,
  "streamFlushMs": 1200,
  "maxReplyChars": 24000,
  "logLevel": "info"
}
```

Config lookup order:

1. `CODEX_FEISHU_CONFIG`
2. `~/.config/codex-feishu/config.json`

Environment overrides include:

- `FEISHU_APP_ID`, `FEISHU_APP_SECRET`
- `FEISHU_TRANSPORT`
- `CODEX_FEISHU_ALLOWED_OPEN_IDS` (comma-separated)
- `CODEX_FEISHU_WORKSPACE_DIR` / `CODEX_FEISHU_PROJECTS_DIR`
- `CODEX_FEISHU_DEFAULT_PROJECT`
- `CODEX_BIN`, `CODEX_MODEL`, `CODEX_PROFILE`, `CODEX_SANDBOX`, `CODEX_APPROVAL`

## State

Bridge session state is stored at:

```text
~/.codex-feishu/state.json
```

It maps:

```text
chatId + project -> Codex thread_id
```

## Notes

- Default work path is `~/`; set `workspaceDir` / `projectsBaseDir`, `CODEX_FEISHU_WORKSPACE_DIR`, or `--workspace-dir` to override the workspace root. Set `defaultProject` / `--default-project` to choose a subdirectory; `.` means the workspace root itself.
- Project names support Unicode, including Chinese. For safety, project names cannot be empty, `..`, or contain path separators.
- `codex-feishu start` starts a background process and writes pid/log files under `stateDir` (`~/.codex-feishu` by default).
- `codex-feishu run` stays in the foreground and is better for first-time debugging.
- `promptTimeoutMs: 0` means no bridge-side timeout.
- The bridge does not expose secrets in `codex-feishu config`.
- `ownerOnly: true` is recommended. In group chats, still verify the sender open_id.

## Development

```bash
npm install
npm run build
node ./bin/codex-feishu.js help
```

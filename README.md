# @nilskluewer/pi-copy-to-clipboard

A Pi extension that lets the model copy exact text, commands, and code to the system clipboard without executing it.

This is useful with clipboard managers such as Maccy.

## Install

Install the published npm package globally:

```bash
pi install npm:@nilskluewer/pi-copy-to-clipboard
```

Install directly from GitHub:

```bash
pi install git:github.com/nilskluewer/pi-copy-to-clipboard
```

Install from a local checkout:

```bash
pi install /path/to/pi-copy-to-clipboard
```

Run `/reload` after installing it in an existing Pi session.

## Usage

Ask Pi explicitly to copy something:

> Copy the exact Bash command from your previous response to my clipboard history.
> Do not execute it.
> Do not include the shell prompt, Markdown fences, or explanation.

The extension registers the `copy_to_clipboard` tool.

The tool accepts the exact text to copy and an optional label.

It preserves whitespace and newlines and never executes the supplied text. Text must be valid Unicode without embedded NUL characters.

## Platform support

Requires Node.js 22.19 or later. No extra npm runtime dependencies are needed.

| Environment | Clipboard backend | Requirements |
| --- | --- | --- |
| macOS | `pbcopy` with a UTF-8 locale | Included with macOS; Maccy can record the result. |
| Windows | Windows PowerShell, then PowerShell 7 (`pwsh.exe`) | Clipboard access and a permitted PowerShell process. No `clip.exe` fallback, to avoid Unicode corruption. |
| WSL 1 / 2 | Windows PowerShell via interop, then WSLg display tools | Windows interop enabled. Tries PATH, then the standard `/mnt/c/Windows/...` path. Custom Windows mount paths need a PATH entry. |
| Linux / WSLg — Wayland | `wl-copy`, then X11 tools if a display is available | Install `wl-clipboard` and allow access to the display. |
| Linux / WSLg — X11 | `xclip`, then `xsel` | Install either tool and allow access to the display. |
| Termux | `termux-clipboard-set` | Install the Termux:API app and `termux-api` package. |
| Headless / SSH / Mosh | OSC 52 terminal escape sequence | An interactive terminal that supports and permits clipboard writes. |

For Debian or Ubuntu desktops:

```bash
sudo apt install wl-clipboard xclip
```

Clipboard commands have a five-second timeout per attempt. Failed backends fall back to the next available backend. Cancelled calls stop without further attempts.

### Terminal and remote sessions

If no OS clipboard command works, interactive sessions try OSC 52. SSH and Mosh sessions send OSC 52 directly to the client terminal. They do not change the server clipboard or wait for server-side display tools. Set `PI_CLIPBOARD_OSC52=1` when a remote session has no SSH/Mosh environment markers.

Terminal delivery is **unconfirmed**: the tool asks you to paste to check it. It does not claim that the clipboard was updated. The limit is 75,000 bytes of UTF-8 text. Larger text can still use a local OS clipboard backend.

The extension wraps OSC 52 for tmux. Your tmux and terminal settings must allow passthrough and clipboard writes. Clipboard history recording depends on your clipboard manager.

RPC/JSON and print modes never emit clipboard escape sequences, even when stdout is a terminal. Local desktop clipboard writes can work in these modes, but headless or remote calls fail with a clear error if the client clipboard cannot be reached.

## Development

Install without Pi's host-provided peer packages:

```bash
npm ci --omit=peer
npm test
npm run smoke
```

The smoke test loads the packed tarball in Pi and checks that the tool is registered. It needs a global Pi installation. For a separate Pi installation, set `PI_SMOKE_CLI` to its JavaScript CLI entry point.

Run real clipboard round-trip tests in a disposable desktop session. These tests replace its clipboard contents:

```bash
# Linux CI / headless machine; requires xvfb, xclip and xsel
xvfb-run -a npm run test:clipboard

# Windows, WSL, macOS, or a Wayland desktop
npm run test:clipboard
```

CI runs unit tests, real clipboard tests, and the package smoke test on Linux, macOS, and Windows. WSL routing is covered by unit tests; native WSL and Wayland round trips need those environments and are not part of the CI matrix.

Inspect the npm tarball without publishing it:

```bash
npm run pack:dry
```

Load the local extension temporarily:

```bash
pi -e .
```

## License

MIT

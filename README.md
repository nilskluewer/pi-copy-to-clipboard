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

It preserves whitespace and newlines and never executes the supplied text.

On macOS, the copied content is placed on the system pasteboard, where Maccy can record it.

## Development

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

import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { release } from "node:os"
import { win32 } from "node:path"
import test from "node:test"
import { createClipboardWriter, runCommand } from "../src/clipboard.js"

// Independent oracle: fixed inputs from the verbatim tool contract, read back
// through OS utilities (not this module). Rejects encoding/newline damage and
// writers that return success without actually taking clipboard ownership.
const samples = [
  "Grüße 🌍 中文 e\u0301", "  spaces\t\n\n", "CRLF\r\nnext\r\n",
  "$(echo DO_NOT_EXECUTE); 'quoted' `code`", "x".repeat(100_001),
]
const env = { ...process.env }
for (const key of ["SSH_CONNECTION", "SSH_CLIENT", "MOSH_CONNECTION", "PI_CLIPBOARD_OSC52"]) delete env[key]
const wsl = process.platform === "linux" && Boolean(env.WSL_DISTRO_NAME || env.WSL_INTEROP || /microsoft|wsl/i.test(release()))
const readPs = "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[System.Text.Encoding]::UTF8; [Console]::Out.Write((Get-Clipboard -Raw))"
const ps = process.platform === "win32"
  ? win32.join(env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
  : "powershell.exe"
const psArgs = ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(readPs, "utf16le").toString("base64")]
const targets = process.platform === "win32" || wsl
  ? [{ name: "Windows/WSL PowerShell", command: ps, args: psArgs }]
  : process.platform === "darwin"
    ? [{ name: "macOS", command: "pbpaste", args: [] }]
    : env.WAYLAND_DISPLAY
      ? [{ name: "Wayland", command: "wl-paste", args: ["--no-newline"] }]
      : env.DISPLAY
        ? [
          { name: "X11 xclip", writer: "xclip", command: "xclip", args: ["-selection", "clipboard", "-out"] },
          { name: "X11 xsel fallback", writer: "xsel", command: "xclip", args: ["-selection", "clipboard", "-out"] },
        ]
        : []

test("a real desktop clipboard must be available for integration tests", () => {
  assert.ok(targets.length > 0, "Use xvfb-run -a npm run test:clipboard on headless Linux")
})
for (const target of targets) test(`${target.name}: verbatim clipboard round trip`, async () => {
  const write = createClipboardWriter({
    env,
    stdout: { isTTY: false },
    run: (cmd, ...args) => target.writer && cmd !== target.writer ? false : runCommand(cmd, ...args),
  })
  for (const sample of samples) {
    const result = await write(sample)
    assert.equal(result.delivery, "command")
    const read = spawnSync(target.command, target.args, {
      encoding: "utf8", env: { ...env, LC_ALL: process.platform === "darwin" ? "en_US.UTF-8" : "C.UTF-8" },
      timeout: 5000, maxBuffer: 2 * 1024 * 1024,
    })
    assert.ifError(read.error)
    assert.equal(read.status, 0, read.stderr)
    assert.equal(read.stdout, sample)
  }
})

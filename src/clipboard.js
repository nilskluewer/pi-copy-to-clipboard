import { spawn } from "node:child_process"
import { release } from "node:os"
import { win32 } from "node:path"

// Read raw UTF-8 bytes, not PowerShell's line-oriented $Input. The script is
// constant: supplied text is stdin data and is never interpolated into code.
const powershellScript = `
$ErrorActionPreference = 'Stop'
try {
  $stream = [Console]::OpenStandardInput()
  $buffer = New-Object System.IO.MemoryStream
  $stream.CopyTo($buffer)
  $text = [System.Text.Encoding]::UTF8.GetString($buffer.ToArray())
  Set-Clipboard -Value $text
} catch { exit 1 }
`
const powershellArgs = [
  "-NoLogo", "-NoProfile", "-NonInteractive", "-Sta", "-EncodedCommand",
  Buffer.from(powershellScript, "utf16le").toString("base64"),
]
const maxOsc52Length = 100_000

/** Run a clipboard writer without retaining pipes in its background daemon. */
export function runCommand(command, args, text, env, signal, timeoutMs = 5000) {
  if (signal?.aborted) return Promise.resolve(false)
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      env,
      stdio: ["pipe", "ignore", "ignore"],
      detached: process.platform !== "win32",
      windowsHide: true,
    })
    let settled = false
    const finish = (ok) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener("abort", abort)
      resolve(ok)
    }
    const abort = () => {
      if (settled) return
      // Failed POSIX writers can leave descendants. Kill their process group
      // only on cancellation/timeout; successful selection owners must survive.
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL")
        else child.kill("SIGKILL")
      } catch { /* The process may already have exited. */ }
      child.stdin.destroy()
      finish(false)
    }
    const timer = setTimeout(abort, timeoutMs)
    child.on("error", () => finish(false))
    child.on("close", (code) => finish(code === 0))
    child.stdin.on("error", () => {}) // A failed writer may close stdin early.
    signal?.addEventListener("abort", abort, { once: true })
    if (signal?.aborted) abort()
    else child.stdin.end(text, "utf8")
  })
}

/** Options also let tests exercise OS routing without changing process globals. */
export function createClipboardWriter({
  platform = process.platform,
  env = process.env,
  osRelease = release(),
  stdout = process.stdout,
  run = runCommand,
} = {}) {
  return async function writeClipboard(text, signal, allowTerminal = true) {
    if (typeof text !== "string" || text.length === 0) {
      throw new Error("Clipboard text must be a non-empty string")
    }
    // OS text clipboards cannot reliably represent embedded NUL characters.
    if (text.includes("\0") || !text.isWellFormed()) {
      throw new Error("Clipboard text must be valid Unicode without NUL characters")
    }
    signal?.throwIfAborted()
    const wsl = platform === "linux" && Boolean(
      env.WSL_DISTRO_NAME || env.WSL_INTEROP || /microsoft|wsl/i.test(osRelease),
    )
    const remote = Boolean(env.SSH_CONNECTION || env.SSH_CLIENT || env.MOSH_CONNECTION
      || env.PI_CLIPBOARD_OSC52 === "1")
    const terminal = allowTerminal && stdout.isTTY
    if (remote && !terminal) {
      throw new Error("Client clipboard requires an OSC 52-capable terminal; RPC/JSON output cannot deliver it")
    }
    const commands = []
    const add = (backend, command, args = [], commandEnv = env) => {
      commands.push({ backend, command, args, env: commandEnv })
    }

    if (platform === "win32" || wsl) {
      const candidates = platform === "win32"
        ? [win32.join(env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), "powershell.exe", "pwsh.exe"]
        : ["powershell.exe", "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe", "pwsh.exe"]
      for (const command of new Set(candidates)) add("powershell", command, powershellArgs)
    }
    if (platform === "darwin") {
      add("pbcopy", "pbcopy", [], { ...env, LC_ALL: "en_US.UTF-8" })
    } else if (platform !== "win32") {
      if (env.TERMUX_VERSION) add("termux", "termux-clipboard-set")
      if (env.WAYLAND_DISPLAY || env.XDG_SESSION_TYPE === "wayland") add("wayland", "wl-copy", ["--type", "text/plain;charset=utf-8"])
      if (env.DISPLAY) {
        add("xclip", "xclip", ["-selection", "clipboard"])
        add("xsel", "xsel", ["--clipboard", "--input"])
      }
    }

    let backend
    // A server clipboard is not the user's client clipboard. Do not change it
    // or wait on its display tools when terminal delivery is required.
    for (const candidate of remote ? [] : commands) {
      signal?.throwIfAborted()
      const ok = await run(candidate.command, candidate.args, text, candidate.env, signal)
      signal?.throwIfAborted()
      if (ok) {
        backend = candidate.backend
        break
      }
    }

    // Never put escape sequences into RPC/JSON output. Terminal writes are
    // best-effort, not proof that a clipboard was updated. Remote sessions send
    // directly to the client terminal.
    if (terminal && (remote || !backend)) {
      const encoded = Buffer.from(text, "utf8").toString("base64")
      if (encoded.length > maxOsc52Length) {
        throw new Error("Clipboard terminal delivery exceeds the OSC 52 limit (75 KB of UTF-8 text)")
      }
      const osc = `\x1b]52;c;${encoded}\x07`
      const sequence = env.TMUX ? `\x1bPtmux;\x1b${osc}\x1b\\` : osc
      stdout.write(sequence)
      return { backend: "osc52", delivery: "unconfirmed" }
    }
    if (backend) return { backend, delivery: "command" }
    throw new Error(
      "Clipboard unavailable. Linux: install wl-clipboard (Wayland) or xclip/xsel (X11) and check display access. "
      + "Windows/WSL: enable Windows interop and make powershell.exe available. "
      + "Headless/SSH: use a terminal with OSC 52 clipboard support.",
    )
  }
}

export const writeClipboard = createClipboardWriter()

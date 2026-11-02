import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { setTimeout as delay } from "node:timers/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { createClipboardWriter, runCommand } from "../src/clipboard.js"

// Oracle: the tool contract requires verbatim text, no execution, and no false
// success. These cases reject interpolation, trimming, clip.exe Unicode loss,
// wrong routing, ignored failures, and escape sequences in machine output.
const text = "  Grüß dich 🌍 中文\t\r\n$(touch SHOULD_NOT_EXIST); 'quotes'\n\n"
function harness(options = {}, succeeds = () => true) {
  const calls = [], output = []
  const write = createClipboardWriter({
    platform: "linux", env: {}, osRelease: "Linux", stdout: { isTTY: false, write: s => output.push(s) },
    run: async (...args) => { calls.push(args); return succeeds(...args) },
    ...options,
  })
  return { write, calls, output }
}

test("Windows uses a constant encoded PowerShell script and raw text data", async () => {
  const h = harness({ platform: "win32", env: { SystemRoot: "D:\\Windows" } })
  assert.deepEqual(await h.write(text), { backend: "powershell", delivery: "command" })
  const [cmd, args, input] = h.calls[0]
  assert.equal(cmd, "D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe")
  assert.equal(input, text)
  assert.ok(args.includes("-NonInteractive"))
  assert.ok(args.includes("-Sta"))
  const script = Buffer.from(args.at(-1), "base64").toString("utf16le")
  assert.match(script, /OpenStandardInput/)
  assert.match(script, /UTF8.GetString/)
  assert.match(script, /ErrorActionPreference = 'Stop'/)
  assert.ok(!script.includes(text))
  assert.ok(!h.calls.some(([cmd]) => /clip\.exe$/.test(cmd)))
})

for (const options of [
  { env: { WSL_DISTRO_NAME: "Ubuntu" } },
  { env: { WSL_INTEROP: "/run/WSL/1_interop" } },
  { osRelease: "6.6.87.2-microsoft-standard-WSL2" },
]) test(`WSL detection: ${JSON.stringify(options)}`, async () => {
  const h = harness(options)
  assert.equal((await h.write(text)).backend, "powershell")
  assert.equal(h.calls[0][0], "powershell.exe")
})

test("WSL tries the mounted Windows executable when PATH interop is absent", async () => {
  const h = harness({ env: { WSL_DISTRO_NAME: "Ubuntu" } }, cmd => cmd.startsWith("/mnt/c/"))
  assert.equal((await h.write(text)).backend, "powershell")
  assert.equal(h.calls.length, 2)
})

test("WSL falls back to WSLg when Windows interop fails", async () => {
  const h = harness({ env: { WSL_INTEROP: "yes", WAYLAND_DISPLAY: "wayland-0" } }, cmd => cmd === "wl-copy")
  assert.equal((await h.write(text)).backend, "wayland")
  assert.equal(h.calls.at(-1)[2], text)
})

test("Wayland falls back to xclip then xsel, without modifying text", async () => {
  const h = harness({ env: { XDG_SESSION_TYPE: "wayland", DISPLAY: ":1" } }, cmd => cmd === "xsel")
  assert.equal((await h.write(text)).backend, "xsel")
  assert.deepEqual(h.calls.map(c => c[0]), ["wl-copy", "xclip", "xsel"])
  for (const c of h.calls) assert.equal(c[2], text)
})

test("macOS requests UTF-8 irrespective of the inherited locale", async () => {
  const h = harness({ platform: "darwin", env: { LC_ALL: "C" } })
  assert.equal((await h.write(text)).backend, "pbcopy")
  assert.equal(h.calls[0][3].LC_ALL, "en_US.UTF-8")
})

test("Termux routes to its API tool", async () => {
  const h = harness({ platform: "android", env: { TERMUX_VERSION: "0.118" } })
  assert.equal((await h.write(text)).backend, "termux")
})

test("headless non-TTY fails rather than claiming success or writing OSC 52", async () => {
  const h = harness()
  await assert.rejects(h.write(text), /Clipboard unavailable/)
  assert.deepEqual(h.output, [])
})

test("failed desktop commands produce an actionable error", async () => {
  const h = harness({ env: { DISPLAY: ":99" } }, () => false)
  await assert.rejects(h.write(text), /install wl-clipboard/)
  assert.equal(h.calls.length, 2)
})

test("OSC 52 uses exact UTF-8 and reports delivery as unconfirmed", async () => {
  const output = []
  const h = harness({ stdout: { isTTY: true, write: s => { output.push(s); return false } } })
  assert.deepEqual(await h.write(text), { backend: "osc52", delivery: "unconfirmed" })
  assert.equal(output[0], `\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`)
})

test("tmux OSC 52 passthrough escapes the inner ESC", async () => {
  let output
  const h = harness({ env: { TMUX: "tmux" }, stdout: { isTTY: true, write: s => { output = s } } })
  await h.write("a")
  assert.equal(output, "\x1bPtmux;\x1b\x1b]52;c;YQ==\x07\x1b\\")
})

test("SSH delivers directly to the client without changing the server clipboard", async () => {
  let output
  const h = harness({ env: { SSH_CONNECTION: "ssh", DISPLAY: ":1" }, stdout: { isTTY: true, write: s => { output = s } } })
  assert.equal((await h.write(text)).backend, "osc52")
  assert.match(output, /\x1b\]52;/)
  assert.equal(h.calls.length, 0)
})

test("remote RPC fails instead of reporting a server clipboard as the client", async () => {
  const h = harness({ env: { SSH_CONNECTION: "ssh", DISPLAY: ":1" } })
  await assert.rejects(h.write(text), /Client clipboard requires/)
  assert.deepEqual(h.output, [])
})

test("machine/print modes disable OSC 52 even when stdout is a terminal", async () => {
  const output = []
  const h = harness({ stdout: { isTTY: true, write: s => output.push(s) } })
  await assert.rejects(h.write(text, undefined, false), /Clipboard unavailable/)
  const remote = harness({ env: { SSH_CONNECTION: "ssh" }, stdout: { isTTY: true, write: s => output.push(s) } })
  await assert.rejects(remote.write(text, undefined, false), /Client clipboard requires/)
  assert.deepEqual(output, [])
})

test("OSC 52 boundary is measured in UTF-8 bytes, not JS characters", async () => {
  const h = harness({ stdout: { isTTY: true, write: () => {} } })
  await h.write("a".repeat(75_000))
  await assert.rejects(h.write("a".repeat(75_001)), /exceeds/)
  await assert.rejects(h.write("🌍".repeat(18_751)), /exceeds/)
})

test("invalid clipboard text fails before any side effects", async () => {
  const h = harness({ platform: "win32" })
  for (const bad of ["", null, "a\0b", "\ud800"]) await assert.rejects(h.write(bad))
  assert.equal(h.calls.length, 0)
})

test("cancelled writes do not try another backend", async () => {
  const controller = new AbortController()
  const h = harness({ env: { DISPLAY: ":1" } }, () => { controller.abort(); return false })
  await assert.rejects(h.write(text, controller.signal), { name: "AbortError" })
  assert.equal(h.calls.length, 1)
})

test("real subprocess receives text verbatim as stdin, never as code", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "clipboard-stdin-"))
  try {
    const path = join(tmp, "text")
    const script = 'const fs=require("node:fs");const chunks=[];process.stdin.on("data",c=>chunks.push(c));process.stdin.on("end",()=>fs.writeFileSync(process.argv[1],Buffer.concat(chunks)))'
    assert.equal(await runCommand(process.execPath, ["-e", script, path], text, process.env), true)
    assert.equal(readFileSync(path, "utf8"), text)
  } finally { rmSync(tmp, { recursive: true, force: true }) }
})

test("POSIX cancellation kills writer descendants, not only the parent", { skip: process.platform === "win32" }, async () => {
  const tmp = mkdtempSync(join(tmpdir(), "clipboard-abort-"))
  const ready = join(tmp, "ready"), marker = join(tmp, "late-write")
  const controller = new AbortController()
  const descendant = `require('node:fs').writeFileSync(${JSON.stringify(ready)}, 'ready'); setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'wrong'), 500)`
  const parent = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], {stdio:'ignore'}); setInterval(()=>{},1000)`
  const running = runCommand(process.execPath, ["-e", parent], text, process.env, controller.signal)
  try {
    const deadline = Date.now() + 3000
    while (!existsSync(ready) && Date.now() < deadline) await delay(10)
    assert.ok(existsSync(ready), "descendant must start before cancellation")
    controller.abort()
    assert.equal(await running, false)
    await delay(700)
    assert.equal(existsSync(marker), false, "cancelled descendant must not write later")
  } finally {
    controller.abort()
    await running
    rmSync(tmp, { recursive: true, force: true })
  }
})

test("missing commands, nonzero exit, and hanging writers fail", async () => {
  assert.equal(await runCommand("pi-nonexistent-clipboard-tool", [], text, process.env), false)
  assert.equal(await runCommand(process.execPath, ["-e", "process.exit(1)"], text, process.env), false)
  assert.equal(await runCommand(process.execPath, ["-e", "setInterval(()=>{},1000)"], text, process.env, undefined, 100), false)
})

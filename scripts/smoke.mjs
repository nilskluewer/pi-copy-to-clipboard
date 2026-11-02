#!/usr/bin/env node
// Smoke test: install the packed tarball the way a user gets it, then load it in a real Pi process.
// Catches what repo-local tests cannot: files missing from the tarball, imports that only resolve
// inside the repo, and Pi module-mapping changes. Needs the `pi` binary. Does not call a model.
import { spawn, spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"

const root = resolve(import.meta.dirname, "..")
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
const tmp = mkdtempSync(join(tmpdir(), "pi-smoke-"))
const expectedTool = "copy_to_clipboard"
const probeCommand = "smoke_verify_copy_to_clipboard"

const fail = (message) => {
  console.error("SMOKE FAIL: " + message)
  rmSync(tmp, { recursive: true, force: true })
  process.exit(1)
}

const resolveNpmCliCandidates = () => {
  const candidates = []
  if (process.env.npm_execpath) candidates.push(process.env.npm_execpath)
  const execDir = dirname(process.execPath)
  candidates.push(
    join(execDir, "node_modules", "npm", "bin", "npm-cli.js"),
    join(execDir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  )
  return candidates.filter((candidate) => existsSync(candidate))
}

const npmCli = resolveNpmCliCandidates()[0]

const runNpm = (args, cwd) => {
  let result
  if (npmCli) {
    result = spawnSync(process.execPath, [npmCli, ...args], { cwd, encoding: "utf8" })
  } else if (process.platform === "win32") {
    fail("Cannot locate npm-cli.js. Run this test with npm run smoke.")
  } else {
    result = spawnSync("npm", args, { cwd, encoding: "utf8" })
  }
  if (result.error) fail(`npm ${args.join(" ")}: ${result.error.message}`)
  if (result.status !== 0) fail(`npm ${args.join(" ")}\n${result.stdout ?? ""}${result.stderr ?? ""}`)
  return (result.stdout ?? "").trim()
}

const resolvePiInvocation = (args) => {
  if (process.env.PI_SMOKE_CLI) {
    return { cmd: process.execPath, args: [resolve(process.env.PI_SMOKE_CLI), ...args] }
  }
  try {
    const globalRoot = runNpm(["root", "-g"], tmp).split(/\r?\n/).pop()?.trim()
    if (globalRoot) {
      const piPkgPath = join(globalRoot, "@earendil-works", "pi-coding-agent", "package.json")
      if (existsSync(piPkgPath)) {
        const piPkg = JSON.parse(readFileSync(piPkgPath, "utf8"))
        const binRel = typeof piPkg.bin === "string" ? piPkg.bin : piPkg.bin?.pi
        if (binRel) {
          const cliPath = resolve(dirname(piPkgPath), binRel)
          if (existsSync(cliPath)) return { cmd: process.execPath, args: [cliPath, ...args] }
        }
      }

    }
  } catch {}
  return { cmd: "pi", args }
}

// 1. Pack and install without peer dependencies: Pi supplies its own packages to extensions.
const tarball = runNpm(["pack", "--silent", "--pack-destination", tmp], root).split(/\r?\n/).pop()?.trim()
if (!tarball) fail("npm pack did not return a tarball filename")
writeFileSync(join(tmp, "package.json"), '{"private":true}')
runNpm(["install", join(tmp, tarball), "--omit=peer", "--no-audit", "--no-fund", "--silent"], tmp)
const installed = join(tmp, "node_modules", ...pkg.name.split("/"))

// 2. Write a probe extension that checks pi.getAllTools() on session_start and registers a sentinel command only if the tool exists.
const probePath = join(tmp, "probe.ts")
writeFileSync(
  probePath,
  [
    `export default function probe(pi) {`,
    `  pi.on("session_start", () => {`,
    `    const tools = pi.getAllTools()`,
    `    if (!tools.some((tool) => tool.name === ${JSON.stringify(expectedTool)})) {`,
    `      throw new Error("Missing expected tool: ${expectedTool} (found: " + tools.map((t) => t.name).join(", ") + ")")`,
    `    }`,
    `    pi.registerCommand(${JSON.stringify(probeCommand)}, {`,
    `      description: "Smoke test sentinel command",`,
    `      handler: async () => {},`,
    `    })`,
    `  })`,
    `}`,
  ].join("\n"),
)

// 3. Load every declared extension plus the probe in a real Pi process and verify the sentinel command.
const extensions = (pkg.pi?.extensions ?? []).map((entry) => join(installed, entry))
if (extensions.length === 0) fail("package.json has no pi.extensions entry")
const piArgs = [
  "--mode",
  "rpc",
  "--offline",
  "--no-session",
  "--no-extensions",
  "--no-skills",
  "--no-prompt-templates",
  "--no-themes",
  "--no-context-files",
]
for (const extension of extensions) piArgs.push("-e", extension)
piArgs.push("-e", probePath)

const invocation = resolvePiInvocation(piArgs)
const child = spawn(invocation.cmd, invocation.args, {
  cwd: tmp,
  stdio: ["pipe", "pipe", "pipe"],
})

let stdoutBuf = ""
let diagnostics = ""
let done = false

const finish = (error) => {
  if (done) return
  done = true
  try {
    child.stdin.end()
  } catch {}
  child.kill()
  if (error) fail(error + "\n" + diagnostics.slice(0, 3000))
  console.log(`smoke ok: ${pkg.name} loads in Pi and registers ${expectedTool}`)
  rmSync(tmp, { recursive: true, force: true })
}

const handleRecord = (line) => {
  const trimmed = line.replace(/\r$/, "").trim()
  if (!trimmed.startsWith("{")) return
  let message
  try {
    message = JSON.parse(trimmed)
  } catch {
    return
  }
  if (message.type === "extension_error") {
    return finish(`extension_error in ${message.extensionPath} (${message.event}): ${message.error}`)
  }
  if (message.type === "response" && message.command === "get_commands") {
    if (!message.success) {
      return finish("get_commands failed: " + JSON.stringify(message))
    }
    const commands = message.data?.commands ?? []
    const found = commands.some((cmd) => cmd.name === probeCommand && cmd.source === "extension")
    if (!found) {
      return finish(`Expected sentinel command /${probeCommand} (proving tool ${expectedTool} is registered), got: ${JSON.stringify(commands)}`)
    }
    return finish()
  }
}

child.stdout.on("data", (chunk) => {
  const text = chunk.toString("utf8")
  diagnostics += text
  stdoutBuf += text
  const lines = stdoutBuf.split("\n")
  stdoutBuf = lines.pop() ?? ""
  for (const line of lines) handleRecord(line)
})

child.stderr.on("data", (chunk) => {
  const text = chunk.toString("utf8")
  diagnostics += text
  if (/Failed to load extension|Extension does not export/i.test(text)) {
    finish("extension failed to load: " + text.trim())
  }
})

child.on("error", (error) => finish("could not start pi: " + error.message))
child.on("exit", (code) => finish(`pi exited (code ${code}) before answering`))
child.stdin.write(JSON.stringify({ id: "smoke", type: "get_commands" }) + "\n")
setTimeout(() => finish("timeout after 60 s"), 60_000).unref()

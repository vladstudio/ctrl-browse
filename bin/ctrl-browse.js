#!/usr/bin/env bun
// ctrl-browse CLI — connects to the local daemon (starts it if needed) and
// runs one command scoped to a named session.

import { spawn, execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'

const PORT = parseInt(process.env.CTRL_BROWSE_PORT || '9876', 10)
const DAEMON_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'daemon.js')
const PLIST = path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.ctrl-browse.daemon.plist')

const VALUE_FLAGS = new Set([
  'label', 'body', 'status', 'content-type', 'resource-type', 'filter', 'type', 'method',
  'seed', 'duration', 'steps', 'delay', 'timeout', 'limit', 'text', 'action',
  'times', 'header', 'name', 'fn', 'gone', 'text-gone', 'interval',
  'scale', 'max-width', 'el', 'dpr', 'nth',
])
const REPEAT_FLAGS = new Set(['header']) // repeatable: --header "K: v" --header "K2: v2"

function parse(argv) {
  const out = { cmd: null, args: [], flags: {}, session: null }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '-s' || a === '--session') { out.session = argv[++i]; continue }
    if (a.startsWith('--')) {
      let name = a.slice(2)
      let val
      const eq = name.indexOf('=')
      if (eq !== -1) { val = name.slice(eq + 1); name = name.slice(0, eq) }
      else if (VALUE_FLAGS.has(name)) val = argv[++i]
      else val = true
      if (REPEAT_FLAGS.has(name) && val !== true) (out.flags[name] = out.flags[name] || []).push(val)
      else out.flags[name] = val
      continue
    }
    if (/^-[a-z]$/i.test(a)) { out.flags[a.slice(1)] = true; continue }
    if (!out.cmd) out.cmd = a
    else out.args.push(a)
  }
  return out
}

const HELP = `ctrl-browse — control your existing browser. Every command is scoped to a named
session, and each session is bound to a Chrome tab group with the same name.

usage: ctrl-browse -s <session> <command> [args] [flags]

sessions:
  sessions                        list sessions
  close                           close session (closes its tab group)
  status                          daemon + browser status
  daemon install|uninstall        run daemon as a login service (macOS launchagent)

navigation:
  open <url> | goto <url>         navigate; goto responds with page as markdown
  back | forward | reload
  wait <selector|ms>              wait for element or duration
  wait --text "Welcome"           wait for text (substring match)
  wait --text-gone "Loading…"     wait until text disappears from the page
  wait --gone <selector>          wait until an element is gone
  wait --fn "<js expression>"     poll until the expression is truthy
  wait --network-idle [ms]        no requests for ms (default 500)
  wait --load [--timeout ms]      wait for page load
                                 (all waits take --timeout and --interval)

page:
  dom [--limit n]                 document HTML
  snapshot                        page outline with @refs (refs are stable)
  snapshot -i                     interactive elements with @refs + aria state
  screenshot <path> [--full] [--scale n] [--max-width n] [--el <sel|@ref>]
  viewport <w> <h> [--dpr n]      real viewport resize — reset with: viewport reset
  eval <js>                       run JavaScript in the page
  get text <sel> | get html <sel>
  storage get|set|clear local|session <key> [value]
  scrollintoview <sel>

interact:
  click <sel|@ref> [--force]      real mouse click (center, or a visible part if the
                                 center is covered); --force clicks the center anyway
  fill <sel> <text>               clear + set value (fires input/change)
  type <sel> <text> [--delay ms]  real keystrokes (default delay 15ms)
  press <key[+mod…]>              key press / shortcut — press Escape, press Meta+a
  select <sel> <value|label>
  find role <role> [--name <s>] [--nth N] [click|show]
  find label <accessible name> [--nth N] [click|show]
  find text <text> [--nth N] [click|show]
                                 (--nth N picks the Nth match, 1-based)

mouse:
  mouse move <x> <y> [--duration ms] [--steps n] [--human --seed n]
  mouse down [left|right|middle] | mouse up [button]
  mouse wheel <dy> [dx]

tabs (inside the session):
  tab                             list tabs (tN, tabId, label)
  tab new [url] [--label L]       new tab in the session group
  tab <tN|label|tabId|title>      switch
  tab close [tN|label|tabId]      close (defaults to active)

console:
  console [--clear] [--json]      console messages
  errors [--clear]                page errors

network:
  network route <pattern> [--body <json>] [--status n] [--method M] [--times n]
                      [--header "Name: value"] [--content-type ct] [--resource-type t] [--abort]
                      (preflights are answered automatically; Origin is echoed
                      for credentialed requests — --times N expires the mock after N matches)
  network unroute [pattern]
  network requests [--clear] [--filter pat] [--type xhr,fetch] [--method POST] [--status 2xx|200|400-499]
  network request <n|id>
  (both show [REDACTED] for token-like query params and auth/cookie headers; --raw shows them)

global: -s/--session NAME (or env CTRL_BROWSE_SESSION), --json, --version
`

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// run the daemon as a login service (macOS) so it's always listening —
// kills the ERR_CONNECTION_REFUSED noise the extension logs while it's off
async function daemonCmd(sub) {
  const uid = process.getuid()
  const bootout = () => { try { execSync(`launchctl bootout gui/${uid} ${PLIST}`, { stdio: 'ignore' }) } catch {} }
  if (sub === 'uninstall') {
    bootout()
    try { fs.unlinkSync(PLIST); console.log('launchagent removed — daemon back to on-demand auto-spawn') } catch { console.log('not installed') }
    process.exit(0)
  }
  if (sub !== 'install') { console.error('usage: ctrl-browse daemon install|uninstall'); process.exit(1) }
  const log = path.join(os.homedir(), '.ctrl-browse', 'daemon.log')
  fs.mkdirSync(path.dirname(PLIST), { recursive: true })
  fs.mkdirSync(path.dirname(log), { recursive: true })
  fs.writeFileSync(PLIST, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.ctrl-browse.daemon</string>
  <key>ProgramArguments</key><array><string>${process.execPath}</string><string>${DAEMON_PATH}</string></array>
  <key>EnvironmentVariables</key><dict><key>CTRL_BROWSE_MANAGED</key><string>1</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${log}</string>
  <key>StandardErrorPath</key><string>${log}</string>
</dict></plist>`)
  bootout()
  let ok = false
  for (let i = 0; i < 5 && !ok; i++) {
    await sleep(400) // let launchd settle; bootout reports exit 5 even on success
    try { execSync(`launchctl bootstrap gui/${uid} ${PLIST}`, { stdio: 'ignore' }); ok = true } catch { bootout() }
  }
  if (!ok) { console.error('error: could not bootstrap launchagent (see ' + PLIST + ')'); process.exit(1) }
  console.log('daemon installed as a login service (KeepAlive, restarts on crash, starts at login).\nThe extension now always finds it listening — no more ERR_CONNECTION_REFUSED errors\nin chrome://extensions.\nRemove with: ctrl-browse daemon uninstall')
  process.exit(0)
}

function connect(timeoutMs) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`)
    const t = setTimeout(() => { ws.terminate(); reject(new Error('timeout')) }, timeoutMs)
    ws.on('open', () => { clearTimeout(t); resolve(ws) })
    ws.on('error', (e) => { clearTimeout(t); reject(e) })
  })
}

async function main() {
  const { cmd, args, flags, session } = parse(process.argv.slice(2))
  if (flags.version || flags.v) { console.log(JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8')).version); process.exit(0) }
  if (!cmd || flags.help || cmd === 'help' || flags.h) { console.log(HELP); process.exit(0) }
  if (cmd === 'daemon') { await daemonCmd(args[0]); return }

  let ws
  try {
    ws = await connect(600)
  } catch {
    // daemon not running — spawn it detached and retry
    const daemonPath = DAEMON_PATH
    try {
      spawn(process.execPath, [daemonPath], { stdio: 'ignore', detached: true, env: process.env }).unref()
    } catch {}
    let up = false
    for (let i = 0; i < 60; i++) {
      await sleep(250)
      try { ws = await connect(400); up = true; break } catch {}
    }
    if (!up) {
      console.error(`error: could not start ctrl-browse daemon on 127.0.0.1:${PORT}`)
      process.exit(1)
    }
  }

  const id = `c${Date.now()}${Math.round(Math.random() * 1e6)}`
  // keep the client timeout above the daemon's 30s browser-connect wait
  const timeout = Math.max(35000, (parseInt(flags.timeout, 10) ? parseInt(flags.timeout, 10) + 15000 : 120000))
  let done = false
  const finish = (code) => { if (!done) { done = true; process.exit(code) } }
  const timer = setTimeout(() => { console.error('error: command timed out'); process.exit(1) }, timeout)

  ws.on('message', async (data) => {
    let m
    try { m = JSON.parse(String(data)) } catch { return }
    if (m.id !== id) return
    clearTimeout(timer)
    done = true
    // if the daemon was launchd-managed, unload the agent or KeepAlive restarts it
    // (bootout is racy against the dying daemon — retry until it's really gone)
    if (m.data && m.data.managed && process.platform === 'darwin' && fs.existsSync(PLIST)) {
      for (let i = 0; i < 5; i++) {
        try { execSync(`launchctl bootout gui/${process.getuid()} ${PLIST}`, { stdio: 'ignore' }) } catch {}
        await sleep(400)
        try { (await connect(400)).close() } catch { break }
      }
    }
    if (m.ok === false) { console.error('error: ' + m.error); process.exit(1) }
    if (cmd === 'screenshot' && m.data && m.data.bytes) {
      const p = path.resolve(args[0] || 'screenshot.png')
      fs.writeFileSync(p, Buffer.from(m.data.bytes, 'base64'))
      const kb = Math.round((m.data.bytes.length * 3) / 4 / 1024)
      console.log(flags.json ? JSON.stringify({ saved: p, kb }) : `saved ${p} (${kb} KB)`)
    } else if (flags.json) {
      console.log(JSON.stringify(m.data ?? {}, null, 2))
    } else {
      console.log(m.text ?? '')
    }
    process.exit(0)
  })
  ws.on('error', () => { if (!done) { console.error('error: daemon connection failed'); process.exit(1) } })
  ws.on('close', () => { if (!done) { console.error('error: daemon connection closed'); process.exit(1) } })

  ws.send(JSON.stringify({ type: 'cli', id, session, cmd, args, flags }))
}

main()
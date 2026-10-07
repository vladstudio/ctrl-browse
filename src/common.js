// shared by the CLI and the daemon: port, paths, versions, code identity
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const PORT = parseInt(process.env.CTRL_BROWSE_PORT || '9876', 10)
export const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
export const SRC_DIR = path.join(ROOT, 'src')
export const EXTENSION_DIR = path.join(SRC_DIR, 'extension')
export const STATE_DIR = path.join(os.homedir(), '.ctrl-browse')
export const LOG_FILE = path.join(STATE_DIR, 'daemon.log')

/** @template T @param {() => T} fn @returns {() => T} */
export function once(fn) {
  let done = false
  /** @type {T} */
  let v
  return () => { if (!done) { v = fn(); done = true } return v }
}

/** @param {unknown} e */
export const errMsg = (e) => String((e instanceof Error && e.message) || e)

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'))
export const version = once(() => readJson(path.join(ROOT, 'package.json')).version)
export const manifest = once(() => readJson(path.join(EXTENSION_DIR, 'manifest.json')))

const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex')

// identity of the daemon's code (everything under src/, extension included):
// the CLI hashes the files on disk each run, the daemon once at startup, so a
// daemon still running code from before a `git pull` is detected — no version
// numbers to remember to bump
export function sourceHash() {
  const h = crypto.createHash('sha256')
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (/\.(js|json)$/.test(e.name)) h.update(path.relative(SRC_DIR, p) + '\0').update(fs.readFileSync(p)).update('\0')
    }
  }
  walk(SRC_DIR)
  return h.digest('hex').slice(0, 16)
}

// the extension can't hash the code it is running (an unpacked extension's
// files on disk change under it), so background.js carries a stamp: the hash
// of its own source with the stamp blanked. scripts/gen.js writes it, a test
// keeps it current, and the extension reports it on connect
export const BRIDGE_FILE = path.join(EXTENSION_DIR, 'background.js')
export const STAMP = /const CODE = '[0-9a-f]*'/
// (the PORT line is left out too, so a changed port doesn't read as stale code)
/** @param {string} src background.js source */
export const bridgeHash = (src) => sha256(src.replace(STAMP, "const CODE = ''").replace(/const PORT = \d+/, 'const PORT = 0')).slice(0, 16)
/** @param {string} src */
export const bridgeStamp = (src) => (STAMP.exec(src) || [''])[0].slice(14, -1)

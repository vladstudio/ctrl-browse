// End-to-end: the real CLI, daemon and extension against a real Chromium
// (Chrome for Testing / Chromium — branded Chrome ignores --load-extension).
// Isolated: temp profile, temp HOME, its own port, a copy of the extension.
//   node test/e2e.js            (CHROME_BIN=/path/to/chrome to pick a browser,
//                                E2E_HEADED=1 to watch it)
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.join(HERE, '..')
const PORT = 10400 + Math.floor(Math.random() * 400)
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ctrl-browse-e2e-'))
const HOME = path.join(TMP, 'home')
fs.mkdirSync(HOME)
// run from a copy of the app, so the test can change its source mid-run
const APP = path.join(TMP, 'app')
for (const f of ['bin', 'src', 'package.json']) fs.cpSync(path.join(REPO, f), path.join(APP, f), { recursive: true })
fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(APP, 'node_modules'))
const CLI = path.join(APP, 'bin', 'ctrl-browse.js')

function findChrome() {
  const pw = [path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright'), path.join(os.homedir(), '.cache', 'ms-playwright')].find((d) => fs.existsSync(d)) || ''
  const fromPlaywright = fs.existsSync(pw)
    ? fs.readdirSync(pw).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse().flatMap((d) => [
      path.join(pw, d, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
      path.join(pw, d, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
      path.join(pw, d, 'chrome-linux', 'chrome'),
      path.join(pw, d, 'chrome-linux64', 'chrome'),
    ])
    : []
  const candidates = [process.env.CHROME_BIN, ...fromPlaywright, '/Applications/Chromium.app/Contents/MacOS/Chromium', '/usr/bin/chromium', '/usr/bin/chromium-browser']
  return candidates.find((p) => p && fs.existsSync(p))
}

let failures = 0
function ok(cond, msg, detail) {
  if (cond) console.log('ok  -', msg)
  else { failures++; console.error('FAIL -', msg); if (detail) console.error('      ', String(detail).slice(0, 1500)) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const env = { ...process.env, HOME, CTRL_BROWSE_PORT: String(PORT) }
function run(...args) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, ...args], { env })
    let out = '', err = ''
    p.stdout.on('data', (d) => { out += d })
    p.stderr.on('data', (d) => { err += d })
    p.on('close', (code) => resolve({ code, out, err, toString: () => JSON.stringify({ code, out, err }) }))
  })
}
const s = (...args) => run('-s', 'e2e', ...args)

// ------------------------------------------------------------------ test site
const PAGE = `<!doctype html><title>E2E Page</title>
<h1>Hello e2e</h1>
<p>Some <b>bold</b> text. <a href="/next?token=SECRET123">next page</a></p>
<button id="go" onclick="document.getElementById('out').textContent = 'Clicked!'">Click me</button>
<div id="out"></div>
<form onsubmit="event.preventDefault(); document.getElementById('sent').textContent = 'sent:' + this.q.value">
  <input name="q" id="q" placeholder="Search">
</form>
<div id="sent"></div>
<select id="color"><option value="r">Red</option><option value="g">Green</option></select>
<div id="ed" contenteditable="true">old</div>
<button id="hidden-btn" style="position:relative">Under</button>
<div id="cover" style="position:fixed;left:0;top:0;width:100vw;height:100vh;display:none;background:rgba(0,0,0,.3)" role="dialog" aria-label="Blocking dialog"></div>
<script>console.log('page loaded', location.pathname); setTimeout(() => { throw new Error('boom from page') }, 10)</script>`

const server = http.createServer((req, res) => {
  if (req.url.startsWith('/api/data')) { res.setHeader('content-type', 'application/json'); res.end('{"real":true}'); return }
  if (req.url.startsWith('/api/slow')) { setTimeout(() => { res.end('slow done') }, 1200); return }
  res.setHeader('content-type', 'text/html')
  res.end(req.url.startsWith('/next') ? '<title>Next</title><h1>Next page</h1>' : PAGE)
})
await new Promise((r) => server.listen(0, '127.0.0.1', () => r(undefined)))
const SITE = `127.0.0.1:${/** @type {any} */ (server.address()).port}`

// ------------------------------------------------------------------- browser
const chrome = findChrome()
if (!chrome) { // locally that's a skip; in CI a missing browser must not pass as green
  console.log(`${process.env.CI ? 'FAIL' : 'skip'}: no Chromium found (set CHROME_BIN)`)
  process.exit(process.env.CI ? 1 : 0)
}
const extDir = path.join(APP, 'src', 'extension')
const bg = path.join(extDir, 'background.js')
fs.writeFileSync(bg, fs.readFileSync(bg, 'utf8').replace(/const PORT = \d+/, `const PORT = ${PORT}`)) // the code stamp ignores this line

const daemon = spawn(process.execPath, [path.join(APP, 'src', 'daemon.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] })
let daemonLog = ''
daemon.stdout.on('data', (d) => { daemonLog += d })
daemon.stderr.on('data', (d) => { daemonLog += d })

const browser = spawn(chrome, [
  `--user-data-dir=${path.join(TMP, 'profile')}`,
  `--load-extension=${extDir}`, `--disable-extensions-except=${extDir}`,
  '--no-first-run', '--no-default-browser-check', '--disable-search-engine-choice-screen',
  ...(process.env.E2E_HEADED ? [] : ['--headless=new']),
  'about:blank',
], { stdio: 'ignore' })

async function main() {
  console.log(`# ${path.basename(chrome)} · daemon :${PORT} · site ${SITE}`)
  let r
  for (let i = 0; i < 40; i++) { // the extension connects once its service worker starts
    r = await run('status')
    if (r.out.includes('browser: connected')) break
    await sleep(500)
  }
  ok(r && r.out.includes('browser: connected') && !r.out.includes('older'), 'extension connects, code stamp matches', r)
  if (failures) return

  r = await s('open', `${SITE}/`)
  ok(r.code === 0 && r.out.includes('# Hello e2e') && r.out.includes('**bold**'), 'open (no scheme) → page as markdown', r)
  ok(!r.out.includes('SECRET123') && r.out.includes('[REDACTED]'), 'goto redacts token-like url params', r)

  r = await s('snapshot', '-i')
  ok(r.code === 0 && /@e\d+\s+button\s+"Click me"/.test(r.out), 'snapshot -i lists the button with a ref', r)
  ok(!r.out.includes('SECRET123'), 'snapshot redacts hrefs', r)
  const ref = (/@(e\d+)\s+button\s+"Click me"/.exec(r.out) || [])[1]

  r = await s('click', '@' + ref)
  ok(r.code === 0 && r.out.includes('clicked'), 'click @ref (trusted mouse event)', r)
  r = await s('wait', '--text', 'Clicked!', '--timeout', '3000')
  ok(r.code === 0, 'wait --text sees the click result', r)

  r = await s('find', 'text', 'Click me', 'click')
  ok(r.code === 0 && r.out.includes('clicked'), 'find text … click', r)

  r = await s('fill', '#q', 'hello world')
  ok(r.code === 0, 'fill', r)
  r = await s('eval', 'document.getElementById("q").value')
  ok(r.out.trim() === 'hello world', 'fill set the value', r)
  r = await s('press', 'Enter')
  r = await s('wait', '--text', 'sent:hello world', '--timeout', '3000')
  ok(r.code === 0, 'press Enter submits the form', r)

  r = await s('fill', '#q', '')
  r = await s('type', '#q', 'abc')
  r = await s('get', 'text', '#q')
  r = await s('eval', 'document.getElementById("q").value')
  ok(r.out.trim() === 'abc', 'type sends real keystrokes', r)

  r = await s('select', '#color', 'Green')
  ok(r.code === 0 && r.out.includes('value=g'), 'select by label', r)

  r = await s('fill', '#ed', 'new text')
  r = await s('get', 'text', '#ed')
  ok(r.out.trim() === 'new text', 'fill on contenteditable (trusted insert)', r)

  await s('eval', 'document.getElementById("cover").style.display = "block"')
  r = await s('click', '#hidden-btn')
  ok(r.code === 1 && r.err.includes('covered by') && r.err.includes('Blocking dialog'), 'a covered click names the cover and the dialog', r)
  await s('eval', 'document.getElementById("cover").style.display = "none"')

  r = await s('console', '--since-nav')
  ok(r.out.includes('page loaded'), 'console captures page logs', r)
  r = await s('errors')
  ok(r.out.includes('boom from page'), 'errors captures uncaught exceptions', r)

  r = await s('network', 'route', `${SITE}/api/data*`, '--body', '{"mock":1}')
  ok(r.code === 0, 'network route', r)
  r = await s('eval', 'fetch("/api/data").then((x) => x.text())')
  ok(r.out.includes('"mock":1'), 'route mocks the response', r)
  await s('network', 'unroute')
  r = await s('eval', 'fetch("/api/data").then((x) => x.text())')
  ok(r.out.includes('"real":true'), 'unroute restores the real response', r)

  await s('eval', 'fetch("/api/slow"); 1')
  const t0 = Date.now()
  r = await s('wait', '--network-idle', '300', '--timeout', '5000')
  ok(r.code === 0 && Date.now() - t0 > 900, `wait --network-idle waits for the in-flight request (${Date.now() - t0}ms)`, r)

  r = await s('network', 'requests', '--filter', 'api')
  ok(r.out.includes('/api/slow') && r.out.includes('200'), 'network requests lists traffic', r)

  const shot = path.join(TMP, 'shot.png')
  r = await s('screenshot', shot, '--el', 'h1', '--pad', '4')
  ok(r.code === 0 && fs.readFileSync(shot).subarray(1, 4).toString() === 'PNG', 'screenshot --el writes a PNG', r)

  r = await s('dom')
  ok(r.out.includes('<h1>Hello e2e</h1>'), 'dom', r)

  r = await s('tab', 'new', `${SITE}/next`, '--label', 'two')
  ok(r.code === 0, 'tab new', r)
  r = await s('tab')
  ok(r.out.includes('label=two') && r.out.includes('t2'), 'tab list', r)
  r = await s('tab', 'close', 'two')
  ok(r.code === 0, 'tab close', r)

  r = await s('goto', `${SITE}/next`)
  ok(r.out.includes('# Next page'), 'goto', r)
  r = await s('back')
  ok(r.code === 0, 'back', r)
  r = await s('get', 'text', 'h1')
  ok(r.out.trim() === 'Hello e2e', 'back really went back', r)

  r = await run('-s', 'e2e-chrome', 'open', 'chrome://version')
  ok(r.code === 0 && r.out.includes('navigated only'), 'open chrome://version on a new session', r)
  r = await run('-s', 'e2e-chrome', 'goto', `${SITE}/next`)
  ok(r.code === 0 && r.out.includes('# Next page'), 'goto from a chrome:// page to a normal one', r)
  await run('-s', 'e2e-chrome', 'close')

  const par = await Promise.all([1, 2, 3].map(() => run('-s', 'e2e-par', 'eval', '1+1')))
  ok(par.every((x) => x.code === 0 && x.out.trim() === '2'), 'parallel commands on a new session', par.join('\n'))
  r = await run('sessions')
  ok((r.out.match(/^e2e-par /gm) || []).length === 1, 'parallel commands made one session', r)
  await run('-s', 'e2e-par', 'close')

  // the daemon's code changes on disk (git pull, local edit): the next command
  // still works, on a fresh daemon running the new code
  const pidOf = async () => (/pid (\d+)/.exec((await run('status')).out) || [])[1]
  const pid1 = await pidOf()
  fs.appendFileSync(path.join(APP, 'src', 'daemon', 'util.js'), '\n// changed by the e2e test\n')
  r = await s('get', 'text', 'h1')
  ok(r.code === 0 && r.out.trim() === 'Hello e2e', 'after a source change, the command runs on a restarted daemon', r)
  const pid2 = await pidOf()
  ok(pid1 && pid2 && pid1 !== pid2, `the daemon was replaced (pid ${pid1} → ${pid2})`)

  r = await s('close')
  ok(r.code === 0 && r.out.includes('closed'), 'close', r)
}

try {
  await main()
} catch (e) {
  failures++
  console.error('FAIL - crashed:', e)
} finally {
  await run('shutdown')
  const exited = (p) => new Promise((r) => { if (p.exitCode !== null || p.signalCode) r(undefined); else { p.on('exit', r); setTimeout(r, 5000) } })
  browser.kill()
  daemon.kill()
  server.close()
  await Promise.all([exited(browser), exited(daemon)]) // the profile is in use until the browser is gone
  if (failures) console.error('\ndaemon log:\n' + daemonLog.slice(-4000))
  fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  console.log(failures ? `\n${failures} failure(s)` : '\nall e2e tests passed')
  process.exit(failures ? 1 : 0)
}

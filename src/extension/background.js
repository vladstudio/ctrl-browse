// ctrl-browse bridge — connects to the local daemon (ws://127.0.0.1:9876) and
// executes chrome.tabs / chrome.tabGroups / chrome.debugger (CDP) calls.
const PORT = 9876
// sha256 of this file with this value blanked (scripts/gen.js) — tells the
// daemon whether Chrome runs the code that's on disk or an older load
const CODE = '746589ae4292fd6c'

/** @type {WebSocket|null} */
let ws = null
let backoff = 2000
let lastSeen = 0

function send(obj) {
  if (ws && ws.readyState === 1) { try { ws.send(JSON.stringify(obj)) } catch {} }
}

function schedule() {
  // fast retries only shortly after a successful connection; once the daemon
  // has been absent a while, the 30s alarm does the probing instead — keeps
  // the SW console from filling with connection-refused errors while idle
  if (Date.now() - lastSeen > 60000) return
  setTimeout(connect, backoff)
  backoff = Math.min(backoff * 2, 30000)
}

function connect() {
  if (ws && (ws.readyState === 0 || ws.readyState === 1)) return
  let sock
  try { sock = new WebSocket(`ws://127.0.0.1:${PORT}`) } catch { return schedule() }
  ws = sock
  sock.onopen = () => { backoff = 2000; lastSeen = Date.now(); send({ event: 'hello', code: CODE }) }
  sock.onmessage = (ev) => {
    let m
    try { m = JSON.parse(ev.data) } catch { return }
    if (m && m.event === 'ping') { send({ event: 'pong' }); return }
    if (m && m.event === 'pong') return
    if (m && m.id !== undefined) handle(m) // never rejects: errors are sent back
  }
  sock.onclose = () => { ws = null; schedule() }
  sock.onerror = () => {}
}

async function handle(m) {
  try {
    const fn = handlers[m.cmd]
    if (!fn) throw new Error(`unknown bridge command: ${m.cmd}`)
    const result = await fn(m)
    send({ id: m.id, ok: true, result })
  } catch (e) {
    send({ id: m.id, ok: false, error: e instanceof Error ? e.message : String(e) })
  }
}

const handlers = {
  'tabs.create': (m) => chrome.tabs.create(m.props),
  'tabs.get': (m) => chrome.tabs.get(m.tabId),
  'tabs.update': (m) => chrome.tabs.update(m.tabId, m.props),
  'tabs.remove': (m) => chrome.tabs.remove(m.tabId),
  'tabs.reload': (m) => chrome.tabs.reload(m.tabId),
  'tabs.goBack': (m) => chrome.tabs.goBack(m.tabId),
  'tabs.goForward': (m) => chrome.tabs.goForward(m.tabId),
  'tabs.query': (m) => chrome.tabs.query(m.query || {}),
  'tabs.group': (m) => (m.groupId ? chrome.tabs.group({ tabIds: m.tabIds, groupId: m.groupId }) : chrome.tabs.group({ tabIds: m.tabIds })),
  'windows.update': (m) => chrome.windows.update(m.windowId, m.props),
  'groups.update': (m) => chrome.tabGroups.update(m.groupId, m.props),
  'groups.query': async (m) => {
    // filter by exact title ourselves to avoid pattern-matching surprises
    const all = await chrome.tabGroups.query({})
    const title = m.query && m.query.title
    return title ? all.filter((g) => g.title === title) : all
  },
  'debug.attach': async (m) => { await chrome.debugger.attach({ tabId: m.tabId }, '1.3'); return {} },
  'debug.detach': async (m) => { await chrome.debugger.detach({ tabId: m.tabId }); return {} },
  'debug.send': (m) => chrome.debugger.sendCommand({ tabId: m.tabId }, m.method, m.params || {}),
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (source && source.tabId !== undefined) send({ event: 'debugEvent', tabId: source.tabId, method, params })
})

chrome.debugger.onDetach.addListener((source) => {
  if (source && source.tabId !== undefined) send({ event: 'debugDetached', tabId: source.tabId })
})

// windowClosing tells "the user closed this tab" from "its window went away"
// (a group lost to a closed window keeps its session for re-binding)
chrome.tabs.onRemoved.addListener((tabId, info) => send({ event: 'tabs.onRemoved', tabId, windowClosing: info.isWindowClosing }))

chrome.tabGroups.onRemoved.addListener((group) => send({ event: 'groups.onRemoved', groupId: group.id }))

chrome.alarms.create('cb-connect', { periodInMinutes: 0.5 })
chrome.alarms.onAlarm.addListener(() => connect())

connect()
// session registry, persisted to ~/.ctrl-browse/state.json
import fs from 'node:fs'
import { STATE_DIR, STATE_FILE } from './util.js'

export let state = { sessions: {} }
try {
  const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
  if (raw && typeof raw === 'object') state = { sessions: raw.sessions || {} }
} catch {}
let persistTimer = null
export function persist() {
  clearTimeout(persistTimer)
  persistTimer = setTimeout(() => {
    try {
      fs.mkdirSync(STATE_DIR, { recursive: true })
      const tmp = STATE_FILE + '.tmp'
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2))
      fs.renameSync(tmp, STATE_FILE)
    } catch (e) { console.error('[ctrl-browse] state write failed:', e.message) }
  }, 250)
}
// ensure pending state is flushed when the daemon goes away
process.on('exit', () => {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true })
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2))
  } catch {}
})

export const sessions = new Map() // name -> session
export function makeSession(name, groupId, { labels = {}, activeTabId = null } = {}) {
  return {
    name, groupId, labels, activeTabId,
    tabs: new Map(),           // tabId -> {title, url} (mirror of chrome state)
    routes: [],                // network routes (runtime only)
    requests: [], reqSeq: 0, reqMap: new Map(),
    console: [], errors: [],
  }
}
for (const [name, s] of Object.entries(state.sessions)) {
  sessions.set(name, makeSession(name, s.groupId, s))
}
export function saveSession(s) {
  state.sessions[s.name] = { groupId: s.groupId, activeTabId: s.activeTabId, labels: s.labels }
  persist()
}
export function dropSession(s) { sessions.delete(s.name); delete state.sessions[s.name]; persist() }

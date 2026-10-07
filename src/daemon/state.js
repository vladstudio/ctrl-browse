// session registry, persisted to ~/.ctrl-browse/state.json
import fs from 'node:fs'
import path from 'node:path'
import { STATE_DIR, errMsg } from '../common.js'

const STATE_FILE = path.join(STATE_DIR, 'state.json')

/**
 * @typedef {object} Route
 * @property {string} url
 * @property {boolean} abort
 * @property {{ name: string, value: string }[]} headers
 * @property {string} [body]
 * @property {number} [status]
 * @property {string} [method]
 * @property {number} [times]
 * @property {string} [contentType]
 * @property {string} [resourceType]
 *
 * @typedef {object} Req
 * @property {number} n
 * @property {number} ts       started
 * @property {number} [endTs]  response or failure
 * @property {string} id
 * @property {number} tabId
 * @property {string} method
 * @property {string} url
 * @property {string} [type]
 * @property {number|string|null} status
 * @property {Record<string, string>} [requestHeaders]
 * @property {Record<string, string>|null} [responseHeaders]
 * @property {string} [postData]
 * @property {string} [mimeType]
 * @property {string} [error]
 * @property {string|null} [route]
 * @property {string} [mocked]
 * @property {string} [mockBody]
 * @property {boolean} done
 *
 * @typedef {{ ts: number, tabId: number, type?: string, text: string }} LogEntry
 *
 * @typedef {object} Session
 * @property {string} name
 * @property {number} groupId
 * @property {Record<string, string>} labels  tabId → label
 * @property {number|null} activeTabId
 * @property {Map<number, { title: string, url: string }>} tabs  mirror of chrome state
 * @property {string|null} freshUrl  the session's first tab was just created with this url
 * @property {boolean} windowClosing  its tabs are going away with their window (not closed by the user)
 * @property {Route[]} routes  network mocks (runtime only)
 * @property {Req[]} requests
 * @property {Map<string, Req>} reqMap
 * @property {number} reqSeq
 * @property {LogEntry[]} console
 * @property {LogEntry[]} errors
 */

/**
 * owned: session names whose tab group ctrl-browse created. Only those are
 * re-bound by title (after a restart); a user's own group is never adopted.
 * @type {{ sessions: Record<string, { groupId: number, activeTabId: number|null, labels: Record<string, string> }>, owned: Record<string, boolean> }}
 */
export const state = { sessions: {}, owned: {} }
/** @type {Map<string, Session>} */
export const sessions = new Map()

export function loadState() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
    if (raw && typeof raw === 'object') {
      state.sessions = raw.sessions || {}
      // older state files have no "owned": every session they list was ours
      state.owned = raw.owned || Object.fromEntries(Object.keys(state.sessions).map((k) => [k, true]))
    }
  } catch {} // missing or corrupt: start empty
  for (const [name, s] of Object.entries(state.sessions)) sessions.set(name, makeSession(name, s.groupId, s))
}

/** @type {NodeJS.Timeout|undefined} */
let persistTimer
let dirty = false
export function persist() {
  dirty = true
  clearTimeout(persistTimer)
  persistTimer = setTimeout(flushState, 250)
}
// atomic (tmp + rename) — also run synchronously on exit
export function flushState() {
  clearTimeout(persistTimer)
  if (!dirty) return
  dirty = false
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true })
    const tmp = STATE_FILE + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2))
    fs.renameSync(tmp, STATE_FILE)
  } catch (e) { console.error('[ctrl-browse] state write failed:', errMsg(e)) }
}

/**
 * @param {string} name @param {number} groupId
 * @param {{ labels?: Record<string, string>, activeTabId?: number|null }} [saved]
 * @returns {Session}
 */
export function makeSession(name, groupId, { labels = {}, activeTabId = null } = {}) {
  return {
    name, groupId, labels, activeTabId,
    tabs: new Map(),
    freshUrl: null,
    windowClosing: false,
    routes: [],
    requests: [], reqSeq: 0, reqMap: new Map(),
    console: [], errors: [],
  }
}
/** @param {Session} s */
export function saveSession(s) {
  state.sessions[s.name] = { groupId: s.groupId, activeTabId: s.activeTabId, labels: s.labels }
  state.owned[s.name] = true
  persist()
}
/** the group is gone; ownership stays so a restored group is re-bound later @param {Session} s */
export function dropSession(s) { sessions.delete(s.name); delete state.sessions[s.name]; persist() }
/** explicit close: forget the name entirely @param {Session} s */
export function forgetSession(s) { dropSession(s); delete state.owned[s.name]; persist() }

// session ↔ tab group binding and tab resolution
import { GROUP_COLORS, warn, errMsg } from './util.js'
import { state, sessions, makeSession, saveSession, dropSession } from './state.js'
import { rpc, waitBrowser } from './bridge.js'

/** @typedef {import('./state.js').Session} Session */

let colorIdx = 0
const inflight = new Map() // name → ensure() chain

// serialized per name: two commands racing on a new name must not create two groups
/** @returns {Promise<Session>} */
export function ensureSession(name, opts = {}) {
  const p = (inflight.get(name) || Promise.resolve()).catch(() => {}).then(() => ensure(name, opts))
  inflight.set(name, p)
  const clear = () => { if (inflight.get(name) === p) inflight.delete(name) }
  p.then(clear, clear)
  return p
}

/** @returns {Promise<Session>} */
async function ensure(name, { create = true, url = undefined } = {}) {
  await waitBrowser()
  // one query answers both "is our group still there?" and "is there one to re-bind?"
  /** @type {{ id: number, title?: string }[]} */
  const groups = await rpc('groups.query', { query: {} }, 8000)
  /** @type {Session|null} */
  let s = sessions.get(name) || null
  if (s && !groups.some((g) => g.id === s?.groupId)) {
    dropSession(s) // gone, or Chrome restarted (new group ids): re-bind by title below
    s = null
  }
  if (!s) s = await adopt(name, groups.filter((g) => g.title === name))
  if (!s && create) s = await createSession(name, url)
  if (!s) throw new Error(`no such session: "${name}"`)
  return s
}

// re-bind a group we created earlier (daemon or Chrome restart) by its title
async function adopt(name, groups) {
  if (!groups.length) return null
  if (!state.owned[name]) {
    throw new Error(`a tab group named "${name}" already exists and ctrl-browse did not create it — pick another session name`)
  }
  const g = groups[0]
  const tabs = (await rpc('tabs.query', { query: { groupId: g.id } }, 8000)).sort((a, b) => a.index - b.index)
  const s = makeSession(name, g.id, { labels: (state.sessions[name] || {}).labels || {}, activeTabId: tabs[0] ? tabs[0].id : null })
  for (const t of tabs) s.tabs.set(t.id, { title: t.title, url: t.url })
  sessions.set(name, s); saveSession(s)
  return s
}

async function createSession(name, url) {
  const tab = await rpc('tabs.create', { props: { url: url || 'about:blank', active: true } }, 20000)
  const groupId = await rpc('tabs.group', { tabIds: [tab.id] }, 8000)
  await rpc('groups.update', { groupId, props: { title: name, color: GROUP_COLORS[colorIdx++ % GROUP_COLORS.length] } }, 8000)
    .catch(warn(`naming tab group "${name}"`))
  const s = makeSession(name, groupId, { activeTabId: tab.id })
  s.tabs.set(tab.id, { title: tab.title || '', url: tab.url || '' })
  s.freshUrl = url || null
  sessions.set(name, s); saveSession(s)
  return s
}

/** @param {Session} s */
export const resolveTab = (s) => resolveTabRef(s).then((r) => r.tab)

/** @param {Session} s @param {string} [ref] */
export async function resolveTabRef(s, ref) {
  let tabs
  try {
    tabs = (await rpc('tabs.query', { query: { groupId: s.groupId } }, 8000)).sort((a, b) => a.index - b.index)
  } catch (e) {
    // transient failure — keep the session (a real empty group drops it below)
    throw new Error(`could not query tabs: ${errMsg(e)}`)
  }
  s.tabs = new Map(tabs.map((t) => [t.id, { title: t.title, url: t.url }]))
  for (const id in s.labels) if (!s.tabs.has(Number(id))) delete s.labels[id] // prune dead tabs
  if (!tabs.length) {
    dropSession(s)
    throw new Error(`session "${s.name}" has no tabs — it will be recreated on next use`)
  }
  if (ref === undefined || ref === null || ref === '') {
    const tab = tabs.find((t) => t.id === s.activeTabId) || tabs[0]
    if (tab.id !== s.activeTabId) { s.activeTabId = tab.id; saveSession(s) }
    return { tab, tabs }
  }
  const m = /^t(\d+)$/i.exec(ref)
  if (m) {
    const i = parseInt(m[1], 10) - 1
    if (i < 0 || i >= tabs.length) throw new Error(`no tab t${m[1]} (${tabs.length} tab${tabs.length === 1 ? '' : 's'} in session)`)
    return { tab: tabs[i], tabs }
  }
  const byLabel = tabs.find((t) => s.labels[t.id] === ref)
  if (byLabel) return { tab: byLabel, tabs }
  if (/^\d+$/.test(ref)) {
    const byId = tabs.find((t) => t.id === Number(ref))
    if (byId) return { tab: byId, tabs }
  }
  const byTitle = tabs.find((t) => t.title === ref)
  if (byTitle) return { tab: byTitle, tabs }
  throw new Error(`no tab matching "${ref}" — use t<N>, a label, a tabId, or an exact title`)
}

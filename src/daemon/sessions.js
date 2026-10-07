// session ↔ tab group binding and tab resolution
import { GROUP_COLORS } from './util.js'
import { state, sessions, makeSession, saveSession, dropSession } from './state.js'
import { rpc, waitBrowser } from './bridge.js'

let colorIdx = 0

export async function ensureSession(name, { create = true, url } = {}) {
  await waitBrowser()
  let s = sessions.get(name)
  if (s) {
    try { await rpc('groups.get', { groupId: s.groupId }, 8000) } catch { dropSession(s); s = null }
  }
  if (!s) {
    let groups = []
    try { groups = await rpc('groups.query', { query: { title: name } }, 8000) } catch {}
    if (groups && groups.length) {
      const g = groups[0]
      const tabs = (await rpc('tabs.query', { query: { groupId: g.id } }, 8000)).sort((a, b) => a.index - b.index)
      s = makeSession(name, g.id, { labels: (state.sessions[name] || {}).labels || {}, activeTabId: tabs[0] ? tabs[0].id : null })
      for (const t of tabs) s.tabs.set(t.id, { title: t.title, url: t.url })
      sessions.set(name, s); saveSession(s)
    }
  }
  if (!s && create) {
    const tab = await rpc('tabs.create', { props: { url: url || 'about:blank', active: true } }, 20000)
    const groupId = await rpc('tabs.group', { tabIds: [tab.id] }, 8000)
    try { await rpc('groups.update', { groupId, props: { title: name, color: GROUP_COLORS[colorIdx++ % GROUP_COLORS.length] } }, 8000) } catch {}
    s = makeSession(name, groupId, { activeTabId: tab.id })
    s.tabs.set(tab.id, { title: tab.title || '', url: tab.url || '' })
    sessions.set(name, s); saveSession(s)
    if (url) s._fresh = true
  }
  if (!s) throw new Error(`no such session: "${name}"`)
  return s
}

export const resolveTab = (s) => resolveTabRef(s).then((r) => r.tab)

export async function resolveTabRef(s, ref) {
  let tabs
  try {
    tabs = (await rpc('tabs.query', { query: { groupId: s.groupId } }, 8000)).sort((a, b) => a.index - b.index)
  } catch (e) {
    // transient failure — keep the session (a real empty group drops it below)
    throw new Error(`could not query tabs: ${e.message}`)
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

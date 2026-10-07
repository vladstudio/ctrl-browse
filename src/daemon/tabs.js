// tabs inside a session, and closing the session
import { normalizeUrl, redactUrl, errMsg } from './util.js'
import { saveSession, forgetSession } from './state.js'
import { rpc } from './bridge.js'
import { resolveTabRef } from './sessions.js'

/** @typedef {import('./state.js').Session} Session */

/** @param {Session} s */
export async function closeCmd(s) {
  const tabs = await rpc('tabs.query', { query: { groupId: s.groupId } }, 8000)
  if (tabs.length) await rpc('tabs.remove', { tabId: tabs.map((t) => t.id) }, 10000)
  forgetSession(s)
  return { text: `session "${s.name}" closed (${tabs.length} tab${tabs.length === 1 ? '' : 's'})` }
}

/** @param {Session} s */
export async function tabList(s, raw = false) {
  const tabs = (await rpc('tabs.query', { query: { groupId: s.groupId } }, 8000)).sort((a, b) => a.index - b.index)
  s.tabs = new Map(tabs.map((t) => [t.id, { title: t.title, url: t.url }]))
  const url = (u) => (raw ? u : redactUrl(u))
  const lines = tabs.map((t, i) =>
    `t${i + 1}${t.id === s.activeTabId ? '*' : ' '} tabId=${t.id}${s.labels[t.id] ? ` label=${s.labels[t.id]}` : ''} "${String(t.title || '').slice(0, 50)}"\n      ${url(t.url)}`)
  const data = tabs.map((t, i) => ({ ref: `t${i + 1}`, tabId: t.id, label: s.labels[t.id] || null, title: t.title, url: url(t.url), active: t.id === s.activeTabId }))
  return { text: lines.join('\n') || '(no tabs)', data: { tabs: data } }
}

/** @param {Session} s */
export async function tabNew(s, url, label) {
  const tab = await rpc('tabs.create', { props: { url: url ? normalizeUrl(url) : 'about:blank', active: true } }, 20000)
  try {
    await rpc('tabs.group', { tabIds: [tab.id], groupId: s.groupId }, 8000)
  } catch (e) {
    await rpc('tabs.remove', { tabId: tab.id }, 5000).catch(() => {}) // best effort: the error below is what matters
    throw new Error('could not add tab to session group: ' + errMsg(e))
  }
  if (label) s.labels[tab.id] = String(label)
  s.activeTabId = tab.id
  s.tabs.set(tab.id, { title: tab.title || '', url: tab.url || url || '' })
  saveSession(s)
  return { text: `opened tab tabId=${tab.id}${label ? ` label=${label}` : ''} in "${s.name}"` }
}

/** @param {Session} s */
export async function tabSwitch(s, ref) {
  const { tab, tabs } = await resolveTabRef(s, ref)
  await rpc('tabs.update', { tabId: tab.id, props: { active: true } }, 8000)
  // focusing the window is cosmetic; a minimized or closing window may refuse
  await rpc('windows.update', { windowId: tab.windowId, props: { focused: true } }, 5000).catch(() => {})
  s.activeTabId = tab.id
  saveSession(s)
  const i = tabs.findIndex((t) => t.id === tab.id)
  return { text: `switched to t${i + 1} (tabId=${tab.id})` }
}

/** @param {Session} s */
export async function tabClose(s, ref) {
  const { tab, tabs } = await resolveTabRef(s, ref)
  const i = tabs.findIndex((t) => t.id === tab.id)
  await rpc('tabs.remove', { tabId: tab.id }, 8000)
  delete s.labels[tab.id]
  s.tabs.delete(tab.id)
  if (s.activeTabId === tab.id) {
    const rest = tabs.filter((t) => t.id !== tab.id)
    s.activeTabId = rest.length ? rest[0].id : null
  }
  saveSession(s)
  return { text: `closed t${i + 1} (tabId=${tab.id})` }
}

/** @param {Session} s @param {string[]} args @param {import('../spec.js').Flags} flags */
export function tabCmd(s, args, flags) {
  if (args[0] === undefined || args[0] === 'list') return tabList(s, !!flags.raw)
  if (args[0] === 'new') return tabNew(s, args[1], flags.label)
  if (args[0] === 'close') return tabClose(s, args[1])
  return tabSwitch(s, args[0])
}

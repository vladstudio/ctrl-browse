// Unit tests for the in-page scripts (md.js, page.js) — real DOM via jsdom,
// no Chrome needed. Complements test/smoke.js, which stubs these scripts out.
import { test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const MD_SRC = readFileSync(path.join(HERE, '..', 'src', 'scripts', 'md.js'), 'utf8')
const PAGE_SRC = readFileSync(path.join(HERE, '..', 'src', 'scripts', 'page.js'), 'utf8')

function dom(html) {
  const w = new JSDOM(html, { url: 'http://localhost:3000/page', runScripts: 'outside-only' }).window
  // jsdom has no layout: report every element as a visible 10x10 box
  w.HTMLElement.prototype.getBoundingClientRect = () => ({ width: 10, height: 10, top: 0, bottom: 10, left: 0, right: 10 })
  return w
}

const evalIn = (w, src, arg) => w.eval(`(${src})(${arg === undefined ? '' : JSON.stringify(arg)})`)

test('md: headings, inline marks, links, images', () => {
  const w = dom('<body><h1>Hi</h1><p>Hello <b>world</b>, see <a href="/docs">docs</a>. <img src="x.png" alt="pic"></p></body>')
  const md = evalIn(w, MD_SRC)
  expect(md.url).toBe('http://localhost:3000/page')
  expect(md.markdown).toContain('# Hi')
  expect(md.markdown).toContain('Hello **world**, see [docs](http://localhost:3000/docs).')
  expect(md.markdown).toContain('![pic](http://localhost:3000/x.png)')
})

test('md: lists, tables, code, blockquote, hidden skipped', () => {
  const w = dom(`<body>
    <ul><li>one</li><li>two</li></ul>
    <ol><li>first</li><li>second</li></ol>
    <pre>const x = 1</pre>
    <table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>
    <blockquote>quoted</blockquote>
    <div style="display:none">invisible</div>
    <script>var nope = "invisible"</script>
  </body>`)
  const md = evalIn(w, MD_SRC).markdown
  expect(md).toContain('- one\n- two')
  expect(md).toContain('1. first\n2. second')
  expect(md).toContain('```\nconst x = 1\n```')
  expect(md).toContain('| A | B |\n| --- | --- |\n| 1 | 2 |')
  expect(md).toContain('> quoted')
  expect(md).not.toContain('invisible')
})

test('page: snapshot assigns sequential refs, labels, roles', () => {
  const w = dom(`<body>
    <button id="go">Go</button>
    <a href="/docs">Docs</a>
    <input type="email" placeholder="Email">
    <input type="submit" value="Send">
    <label for="nm">Name</label><input id="nm">
    <h2>About</h2>
    <button aria-hidden="true">ghost</button>
  </body>`)
  const res = evalIn(w, PAGE_SRC, { interactive: true, limit: 150 })
  expect(res.url).toBe('http://localhost:3000/page')
  expect(res.elements.map((e) => e.role)).toEqual(['button', 'link', 'textbox', 'button', 'textbox'])
  expect(res.elements.map((e) => e.ref)).toEqual(['e1', 'e2', 'e3', 'e4', 'e5'])
  expect(res.elements[2].name).toBe('Email')
  expect(res.elements[3].value).toBe('Send')
  expect(res.elements[4].name).toBe('Name')
  expect(w.document.querySelector('[data-cb-ref="e1"]').id).toBe('go')

  const full = evalIn(w, PAGE_SRC, { interactive: false, limit: 150 })
  const heading = full.elements.find((e) => e.role === 'heading')
  expect(heading.level).toBe('2')
  expect(full.elements.some((e) => e.text === 'ghost')).toBe(false)
})

test('page: find role and find text', () => {
  const w = dom('<body><button>Save</button><a href="/x">a link</a><span>Save your work</span><button>Cancel</button></body>')
  const btns = evalIn(w, PAGE_SRC, { find: { kind: 'role', needle: 'button' } })
  expect(btns.map((b) => b.ref)).toEqual(['e1', 'e2'])
  expect(btns.map((b) => b.tag)).toEqual(['button', 'button'])
  const hits = evalIn(w, PAGE_SRC, { find: { kind: 'text', needle: 'your' } })
  expect(hits.length).toBe(1)
  expect(hits[0].tag).toBe('span')
})

test('page: stable refs, aria state, password values never emitted', () => {
  const w = dom(`<body>
    <input type="password" value="hunter2">
    <button aria-pressed="true" aria-expanded="false">Agent</button>
  </body>`)
  const one = evalIn(w, PAGE_SRC, { interactive: true, limit: 150 })
  const two = evalIn(w, PAGE_SRC, { interactive: true, limit: 150 })
  expect(one.elements.map((e) => e.ref)).toEqual(['e1', 'e2'])
  expect(two.elements.map((e) => e.ref)).toEqual(['e1', 'e2']) // stable across snapshots
  expect(one.elements[0].value).toBeUndefined()
  expect(one.elements[1].pressed).toBe('true')
  expect(one.elements[1].expanded).toBe('false')
})

test('page: find label, role + name filter, contenteditable role', () => {
  const w = dom('<body><button aria-label="Send message">➤</button><button>Cancel</button><div contenteditable="true"></div></body>')
  const send = evalIn(w, PAGE_SRC, { find: { kind: 'role', needle: 'button', name: 'send message' } })
  expect(send.length).toBe(1)
  expect(send[0].tag).toBe('button')
  const cancel = evalIn(w, PAGE_SRC, { find: { kind: 'label', needle: 'cancel' } })
  expect(cancel.length).toBe(1) // innerText counts as an accessible name too
  const boxes = evalIn(w, PAGE_SRC, { find: { kind: 'role', needle: 'textbox' } })
  expect(boxes.some((b) => b.tag === 'div')).toBe(true) // contenteditable div is a textbox
})

test('md: password input values are never printed', () => {
  const w = dom('<body><form><input type="password" name="pw" value="hunter2"><input type="search" name="q" value="hi"></form></body>')
  const md = evalIn(w, MD_SRC).markdown
  expect(md).toContain('[input password pw]')
  expect(md).not.toContain('hunter2')
  expect(md).toContain('q = hi')
})
// ------------------------------------------------------------- actions.js
const ACTIONS_SRC = readFileSync(path.join(HERE, '..', 'src', 'scripts', 'actions.js'), 'utf8')
const act = (w, op, arg = {}) => w.eval(`(${ACTIONS_SRC})(${JSON.stringify(op)}, ${JSON.stringify(arg)})`)

// jsdom has no layout. A tiny one: an element's box comes from data-rect="x,y,w,h"
// (others are 10x10 at 0,0), and elementFromPoint returns the last element in
// document order whose box contains the point — later elements paint on top,
// like the positioned overlays this logic is about
function actDom(html) {
  const w = dom(html)
  const box = (el) => {
    const [x, y, wd, h] = (el.getAttribute('data-rect') || '0,0,10,10').split(',').map(Number)
    return { left: x, top: y, width: wd, height: h, right: x + wd, bottom: y + h }
  }
  w.HTMLElement.prototype.getBoundingClientRect = function () { return box(this) }
  w.HTMLElement.prototype.getClientRects = function () { return this.hasAttribute('data-rect') ? [box(this)] : [] }
  w.Element.prototype.scrollIntoView = () => {}
  w.HTMLElement.prototype.focus = () => {} // jsdom's focus() throws under bun (cross-realm FocusEvent)
  w.document.elementFromPoint = (x, y) => [...w.document.body.querySelectorAll('[data-rect]')]
    .filter((el) => { const r = box(el); return x >= r.left && x < r.right && y >= r.top && y < r.bottom })
    .at(-1) || null
  return w
}

const BUTTON = '<button id="go" data-rect="0,0,100,40">Go <span id="lbl" data-rect="40,10,20,20">now</span></button>'

test('actions: click lands on the center when nothing covers it (children count as the element)', () => {
  const w = actDom(`<body>${BUTTON}</body>`)
  expect(act(w, 'click', { sel: '#go' })).toEqual({ x: 50, y: 20, disabled: false })
  expect(act(w, 'click', { sel: '#missing' })).toBe(null)
})

test('actions: a toast over the center → click a visible part instead', () => {
  const w = actDom(`<body>${BUTTON}<div class="toast" data-rect="30,0,40,40">Saved</div></body>`)
  expect(act(w, 'click', { sel: '#go' })).toEqual({ x: 25, y: 20, disabled: false })
})

test('actions: fully covered → names the cover and the open dialog; --force clicks anyway', () => {
  const w = actDom(`<body>${BUTTON}<div role="dialog" aria-label="Rename workflow" data-rect="0,0,500,500"><div class="scrim fixed" data-rect="0,0,500,500"></div></div></body>`)
  expect(act(w, 'click', { sel: '#go' })).toEqual({ x: 50, y: 20, disabled: false, covered: '<div class="scrim fixed">', dialog: 'Rename workflow' })
  expect(act(w, 'click', { sel: '#go', force: true })).toEqual({ x: 50, y: 20, disabled: false, forced: '<div class="scrim fixed">' })
})

test('actions: disabled and aria-disabled are reported', () => {
  const w = actDom('<body><button id="a" disabled data-rect="0,0,10,10">A</button><div id="b" role="button" aria-disabled="true" data-rect="20,0,10,10">B</div></body>')
  expect(act(w, 'click', { sel: '#a' }).disabled).toBe(true)
  expect(act(w, 'click', { sel: '#b' }).disabled).toBe(true)
})

test('actions: fill sets value, fires input + change, hides passwords', () => {
  const w = actDom('<body><input id="e"><input id="p" type="password"><textarea id="t"></textarea></body>')
  const seen = []
  w.document.getElementById('e').addEventListener('input', () => seen.push('input'))
  w.document.getElementById('e').addEventListener('change', () => seen.push('change'))
  expect(act(w, 'fill', { sel: '#e', value: 'me@x.test' })).toEqual({ ok: true, value: 'me@x.test' })
  expect(seen).toEqual(['input', 'change'])
  expect(act(w, 'fill', { sel: '#p', value: 'hunter2' })).toEqual({ ok: true, value: '[REDACTED]' })
  expect(act(w, 'fill', { sel: '#t', value: 'a\nb' }).ok).toBe(true)
})

test('actions: fill on contenteditable selects content for a trusted insert', () => {
  const w = actDom('<body><div id="ed" contenteditable="true">old text</div></body>')
  const ed = w.document.getElementById('ed')
  if (ed.isContentEditable === undefined) Object.defineProperty(ed, 'isContentEditable', { value: true })
  expect(act(w, 'fill', { sel: '#ed', value: 'new' })).toEqual({ editable: true })
  expect(String(w.getSelection())).toBe('old text')
})

test('actions: select by value or label; lists options on a miss', () => {
  const w = actDom('<body><select id="s"><option value="us">United States</option><option value="de">Germany</option></select><div id="d"></div></body>')
  expect(act(w, 'select', { sel: '#s', value: 'Germany' })).toEqual({ value: 'de', text: 'Germany' })
  expect(act(w, 'select', { sel: '#s', value: 'us' }).value).toBe('us')
  const miss = act(w, 'select', { sel: '#s', value: 'France' })
  expect(miss.error).toContain('France')
  expect(miss.options.map((o) => o.value)).toEqual(['us', 'de'])
  expect(act(w, 'select', { sel: '#d', value: 'x' }).error).toContain('not a <select>')
})

test('actions: @refs from snapshot resolve; hostile refs are just misses', () => {
  const w = actDom('<body><button>Go</button><p id="p">Hello <b>there</b></p></body>')
  evalIn(w, PAGE_SRC, { interactive: true, limit: 150 })
  expect(act(w, 'exists', { sel: '@e1' })).toBe(true)
  expect(act(w, 'exists', { sel: '@e1"] , body, [x="' })).toBe(false)
  expect(act(w, 'get', { sel: '#p', what: 'text' })).toBe('Hello there')
  expect(act(w, 'get', { sel: '#p', what: 'html' })).toBe('Hello <b>there</b>')
  expect(act(w, 'get', { sel: '#nope', what: 'text' })).toBe(null)
})

test('actions: has-text, storage, dom, unknown op', () => {
  const w = actDom('<body><p>Welcome back</p></body>')
  expect(act(w, 'has-text', { text: 'Welcome' })).toBe(true)
  expect(act(w, 'has-text', { text: 'Goodbye' })).toBe(false)
  act(w, 'storage', { sub: 'set', kind: 'local', key: 'k', value: 'v 1' })
  expect(act(w, 'storage', { sub: 'get', kind: 'local', key: 'k' })).toBe('v 1')
  act(w, 'storage', { sub: 'clear', kind: 'local', key: 'k' })
  expect(act(w, 'storage', { sub: 'get', kind: 'local', key: 'k' })).toBe(null)
  expect(act(w, 'dom')).toContain('<p>Welcome back</p>')
  expect(() => act(w, 'nope')).toThrow('unknown page op')
})

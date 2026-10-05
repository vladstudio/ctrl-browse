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
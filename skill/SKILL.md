---
name: ctrl-browse
description: Drive the user's real Chrome (their profile, logins and cookies) from the shell with the ctrl-browse CLI. Use to open pages, read them as markdown, click, fill forms, take screenshots, inspect console errors and network traffic, or mock API responses — e.g. to check a local dev server or reproduce a bug in a logged-in app.
---

# ctrl-browse

`ctrl-browse` controls the user's own Chrome through an extension. Every command
needs a session (`-s <name>`); each session is a Chrome tab group with that
name, so your tabs stay separate from the user's.

## Rules

- Pick one short session name per task (e.g. `-s fix-login`) and reuse it.
- Run `ctrl-browse -s <name> close` when you are done.
- This is the user's real browser with their real accounts. Never submit
  payments, send messages, delete data or change account settings without the
  user's explicit go-ahead.
- If a command says the browser is not connected, ask the user to open Chrome
  with the ctrl-browse extension loaded. Don't retry in a loop.

## Core loop

```bash
ctrl-browse -s task goto http://localhost:3000   # navigate; prints the page as markdown
ctrl-browse -s task snapshot -i                  # interactive elements with @refs
ctrl-browse -s task click @e3                    # act on a ref
ctrl-browse -s task fill @e5 "me@example.com"
ctrl-browse -s task press Enter
ctrl-browse -s task wait --text "Welcome"        # wait for the result, don't sleep
ctrl-browse -s task snapshot -i                  # look again after the page changes
```

- `@refs` stay valid while the element stays in the DOM; re-run `snapshot -i`
  after navigation or big UI changes.
- `find role button --name Save click` or `find text "Sign in" click` skips the
  snapshot when you know what you want.
- If `click` says the element is covered by a dialog, `press Escape` usually
  closes it. Use `--force` only when you mean to click whatever is on top.
- `fill` sets a value at once (works with React inputs and rich-text editors);
  `type` sends real keystrokes for inputs that react per key (autocomplete,
  mentions).

## Debugging a page

```bash
ctrl-browse -s task errors --since-nav           # JS errors since the last load
ctrl-browse -s task console --since-nav
ctrl-browse -s task network requests --type xhr,fetch --status 400-599
ctrl-browse -s task network request 12           # headers + body of request #12
ctrl-browse -s task screenshot /tmp/page.png     # then read the image
ctrl-browse -s task eval "document.title"
```

## Mocking APIs

```bash
ctrl-browse -s task network route "api.example.com/users*" --body '{"users":[]}'
ctrl-browse -s task network route "*/api/save" --status 500 --times 1
ctrl-browse -s task network unroute               # remove all mocks
```

Run `ctrl-browse help` for every command and flag.

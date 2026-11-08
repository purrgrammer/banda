# The specimen

`#/specimen` shows every component of the app with fixture data, in light and dark side by side, at desktop or phone
width, so a screen can be reviewed before and after it is wired. It is for people and agents alike: a reference for
what exists, what is proposed and what is only a spike.

## How it is organised

- `registry.ts` is the one index. Every section has an id, a title, a group, a status (`app`, `proposal` or
  `exploration`), the files of the real components it shows (`sources`) and, when it shows at one width only, `only`.
  The nav, the page's order, `?section=` and each section's header read from it.
- `contents.tsx` maps each group to the components that render its sections, in page order.
- Each group has a folder (`foundation/`, `chat/`, `screens/`, `agent/`, `connections/`, `harness/`, `states/`,
  `explorations/`); `stage.tsx` holds `Section`, `Group` and `Labelled`; `fixtures.ts` holds the band's data.
- `registry.test.ts` renders the page on the server and fails when a rendered section is not registered, a registered
  one does not render at the width it says, ids repeat, or a source path does not exist.

## Adding a section

1. Render the real component from `web/src` (never a copy of it) inside `<Section id="…" note="…">` in the file of its
   group, in the place where it should read.
2. Add its entry to `SECTIONS` in `registry.ts` at the same position. Pick the group by what the owner would look for,
   and the status honestly: `app` for a component the app uses as shown, `proposal` for a UI whose slice is not wired
   yet, `exploration` for a spike with no promise behind it. New spikes start in `explorations/` and move up when the
   design takes them.
3. Run `npm run test:fast -- web/src/specimen/registry.test.ts`, then look at it in the browser at both widths.

A focused page of its own (`#/specimen/<name>`) is for a flow a browser test drives end to end; add it to `url.ts` and
the route, and keep a section in the page that links to it.

## Retiring a section

Remove it when the component it showed left the app, or when another section covers everything it showed with the real
components. Delete the entry and the markup together; the test will say if something still refers to it.

## Links

- A section: `#/specimen?section=approvals`, with `&scheme=light|dark|both` and `&width=desktop|phone`.
- One section alone, with no header or nav, for a screenshot or for an agent reading one thing:
  `#/specimen?section=approvals&scheme=dark&width=phone&only=1`.
- The focused previews: `#/specimen/toolsets`, `#/specimen/mcp`, `#/specimen/activity`, `#/specimen/activity/recorded`,
  `#/specimen/skills/<name>`.

`agent/tool-schemas.json` is a snapshot of the built-in tools' descriptions and schemas; `node scripts/specimen-tools.ts`
regenerates it from the registrations.

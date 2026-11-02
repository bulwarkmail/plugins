# The 2.2 areas

The assistant's 2.2 work comes in five areas, built side by side. Each area
has its own files, so no two areas edit the same lines:

| Area | Group of the build | Lib (lookups, actions) | Panel | Settings | Texts |
| --- | --- | --- | --- | --- | --- |
| context | 1, more context | `src/lib/areas/context.js` | `src/ui/panel/areas/context.js` | `src/ui/settings/ContextSection.jsx` | `src/locales/context/` |
| actions | 2, more actions | `src/lib/areas/actions.js` | `src/ui/panel/areas/actions.js` | `src/ui/settings/ActionsSection.jsx` | `src/locales/actions/` |
| files | 3, Files | `src/lib/areas/files.js` | `src/ui/panel/areas/files.js` | `src/ui/settings/FilesSection.jsx` | `src/locales/files/` |
| chat | 4, chat tools | `src/lib/areas/chat.js` | `src/ui/panel/areas/chat.js` | `src/ui/settings/ChatSection.jsx` | `src/locales/chat/` |
| everywhere | 5, every view | `src/lib/areas/everywhere.js` | `src/ui/panel/areas/everywhere.js` | `src/ui/settings/EverywhereSection.jsx` | `src/locales/everywhere/` |

Whether the webmail offers a host call: `caps(api)` in `src/lib/caps.js`
(false on older webmails). Whether the admin left an area on:
`areaAllowed(config, area)` in `src/lib/config.js`.

## Lookups (`tools`)

```js
{
  name: 'read_thread',                      // tool name the model calls
  description: '…', parameters: { … },      // JSON schema, as in tools.js
  available: (ctx) => boolean,              // offered in this chat? (ctx: the chat's tool context, with the panel areas' toolsCtx)
  run: async (api, args, ctx) => string | { text, widget },
  label: (t, args) => string,               // the step line in the panel
  kind: 'ctx.kind.thread',                  // locale key of the chip in "Looked up"
  icon: 'messages',                         // kit icon name
}
```

## Actions (`actions`)

```js
{
  name: 'tag_message', description: '…', parameters: { … },
  available: (ctx) => boolean,
  alwaysAsk: true | ((args, ctx) => boolean), // ask first whatever the user's mode
  describe: async (api, args, ctx) => ({ summary, plan }),  // summary: the card text, in the user's language
  perform: async (api, plan) => ({ text, undo }),          // text: for the model; undo: anything undo() needs, or null
  undo: async (api, undo) => void,
  icon: 'tag',
}
```

Actions keep the rules of 1.x: ask first or automatic as the user chose
(capped by the admin), at most MAX_AUTO_ACTIONS automatic ones per answer,
Undo where possible, never send or delete mail, never move data out of the
account (no forwarding, no sharing, no public links).

## Panel (`useArea(chat, props)`)

A React hook, called on every render in a fixed order. `chat` has `api`,
`t`, `mode`, `email`, `source`, `turns`, `setTurns`, `key`, `setup`,
`prefs`, `person`, `locale`, `setInput`, `inputRef` and `bridge` (a ref:
`bridge.current.send(…)`, `sendText(text)`, `quick(action)`, once the chat
is ready). It returns any of:

```js
{
  chips: [{ key, icon, label, detail?, title?, onRemove?, onClick?, dashed? }],  // after the message's chip
  promptBlocks: ['…'],         // added to the system prompt (data the model may use)
  toolsCtx: { … },             // merged into the context lookups and actions get
  quick: [{ id, label, icon, run }],   // more entries in the Actions menu
  menus: [{ trigger: '@' | '/', atStart?: boolean, label, items: async (query) => [{ id, label, detail?, icon? }], onPick: (item) => void }],
  header: [{ key, icon, label, onClick, pressed? }],  // buttons in the panel header
  overlay: ReactNode | null,   // shown instead of the transcript (a history list)
  privacyParts: ['ctx.privacy'],  // locale keys of sentences the privacy notice adds
}
```

## Settings

`src/ui/settings/<Area>Section.jsx` exports a component `(props: { api,
setup, prefs, savePrefs })`, shown in the plugin's settings after the
standing instructions. Return null to show nothing.

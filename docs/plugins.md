# Plugins

Plugins add commands and respond to bot events. They are local JavaScript modules, loaded by a level 5 bot owner.

A plugin runs inside the bot process and can access its environment and files. Only install code you trust. Python plugins for modmail-dev are not compatible.

## Directory layout

```text
plugins/
  example/
    index.js
```

The repository includes the `example` plugin. Enable it with:

```text
.plugins list
.plugins load example
.ticketstats
.plugins reload example
.plugins unload example
```

Enabled plugin names persist in SQLite and reload on startup. When using Docker, mount the local plugin directory read-only. Entry reloads re-import the entry module; changes in imported helper modules or dependency packages require a process restart. Install plugin dependencies on the host/build image, never through a chat command.

## Plugin API v1

```js
export default {
  apiVersion: 1,
  name: 'example',
  async start(api) {
    api.registerCommand('ticketstats', {
      level: 2,
      description: 'Show observed ticket count.',
      async execute(context) {
        await context.respond(`Opened: ${api.get('opened') || 0}`);
      },
    });
  },
  async stop() {
    // Stop your timers, connections, and other resources.
  },
  hooks: {
    async threadOpen(event, api) {
      api.set('opened', (api.get('opened') || 0) + 1);
    },
    async message(event, api) {
      // event.ticket and event.message are copies of saved state.
    },
    async threadClose(event, api) {},
  },
};
```

`api.get(key)` and `api.set(key, value)` persist JSON values under the plugin's own namespace. `api.log(text)` adds a short operational event; never log tokens or message bodies. Commands must have unique lowercase names, a description, a level from 2 to 5, and an execute function. Core commands and configured aliases cannot be replaced.

Command context includes `args`, `actorId`, `level`, a copied `ticket` or null, `respond(text)` for the private staff channel, and `reply(text)` for an anonymous reply in the active conversation. Both output methods use the core Components V2 renderer and ping sanitizer. Core authorization runs before the plugin command.

Hooks receive copied state, so mutating an event object does not mutate the inbox. `message` runs after successful initial delivery; it is not a retry/edit/deletion hook. Queued snoozed messages are replayed by the inbox rather than re-emitting this hook. Hook exceptions are recorded without stopping normal inbox work. Plugins must keep hooks short and release resources in stop; code that blocks the Node event loop can block the bot.

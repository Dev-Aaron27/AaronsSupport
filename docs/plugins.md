# 🧩 Plugins Guide (Advanced)

Plugins in Aaron's Support allow you to add custom commands, respond to events, and extend the core functionality of the bot. Plugins are executed as local JavaScript modules and run directly within the bot's environment.

> **⚠️ Security Warning:** Plugins have full access to the bot's process, environment variables, and file system. Only install plugins you explicitly trust.

---

## Directory Layout

Plugins are placed in the `plugins/` directory:

```text
plugins/
  auto-responder/
    index.js
  ticket-stats/
    index.js
```

### Managing Plugins via Chat

You can manage your loaded plugins from Discord (requires level 5 / Bot Owner):

- `.plugins list` — Shows all loaded plugins.
- `.plugins load <name>` — Loads a plugin by folder name.
- `.plugins reload <name>` — Reloads the `index.js` file of a plugin.
- `.plugins unload <name>` — Unloads the plugin.

*Note: Changes to dependencies or helper files require a full bot restart. Only `index.js` changes are dynamically reloaded.*

---

## 🛠️ Plugin API (v1)

A plugin module should export a default object containing the `apiVersion`, `name`, `start/stop` lifecycle methods, and `hooks`.

### 1. Basic Structure

```javascript
export default {
  apiVersion: 1,
  name: 'ticket-stats',
  
  async start(api) {
    // Setup logic, command registration
    api.log('Ticket stats plugin loaded!');
  },

  async stop() {
    // Cleanup timers, external DB connections, etc.
  },

  hooks: {
    // Event listeners
  }
};
```

### 2. Registering Custom Commands

You can register custom commands in the `start(api)` method:

```javascript
  async start(api) {
    api.registerCommand('ping', {
      level: 1, // 1 = Anyone, 2 = Helper, 3 = Mod, 4 = Admin, 5 = Owner
      description: 'Check if the bot is responsive.',
      async execute(context) {
        // context.respond sends a message to the staff channel
        await context.respond(`🏓 Pong! Bot is active.`);
      }
    });

    api.registerCommand('rules', {
      level: 2,
      description: 'Send the server rules to the user in a ticket.',
      async execute(context) {
        if (!context.ticket) {
          return await context.respond('❌ This command must be used inside a ticket!');
        }
        // context.reply sends an anonymous message to the user's DMs
        await context.reply(`**Server Rules:**\n1. Be respectful.\n2. No spamming.`);
      }
    });
  }
```

### 3. Using Hooks (Events)

Hooks allow you to execute code when something happens in Modmail.

**Available Hooks:**
- `threadOpen`: Triggered when a new ticket is created.
- `message`: Triggered when a message is successfully sent to a ticket.
- `threadClose`: Triggered when a ticket is closed.

**Example: Auto-tag an Admin role on new tickets**
```javascript
  hooks: {
    async threadOpen(event, api) {
      // event.ticket contains the ticket database object
      // event.channel contains the newly created Discord channel (if applicable)
      api.log(`Ticket #${event.ticket.id} was just opened.`);
      
      // Let's increment a persistent counter!
      let count = api.get('total_opened') || 0;
      api.set('total_opened', count + 1);
    },
    
    async threadClose(event, api) {
      api.log(`Ticket #${event.ticket.id} closed by ${event.ticket.closed_by}.`);
    }
  }
```

### 4. API Storage Methods

The `api` object provides a scoped key-value store for your plugin:
- `api.get('key')`: Retrieves a parsed JSON value.
- `api.set('key', value)`: Saves a JSON-serializable value.
- `api.log('text')`: Logs a message to the bot's standard output.

---

## 🚀 Advanced Examples

### Example: "Auto-Responder" Plugin
This plugin looks for specific keywords from a user's initial message and posts an internal note for staff.

```javascript
export default {
  apiVersion: 1,
  name: 'auto-responder',
  async start(api) {
    api.log('Auto-Responder started.');
  },
  async stop() {},
  
  hooks: {
    async message(event, api) {
      // Ignore staff replies, we only want user messages
      if (event.message.direction !== 'member') return;

      const content = event.message.content.toLowerCase();
      
      // Check if they asked about a ban
      if (content.includes('banned') || content.includes('unban')) {
        // Send a note in the staff channel (simulated API call)
        api.log(`Ticket #${event.ticket.id} contains an appeal keyword.`);
      }
    }
  }
};
```

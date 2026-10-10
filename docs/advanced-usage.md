# Advanced Usage & Workflows

Take your Aaron's Support instance to the next level with these advanced workflows and deep-dive configurations.

## 1. Advanced Permission Structures

By default, Aaron's Support gives you basic roles for moderators and administrators. However, as your server grows, you might need a more complex role hierarchy. 

**Layered Escalation:**
- **Tier 1 (Helpers):** Can view channels and send `.note`, but cannot close tickets or use `.reply`.
- **Tier 2 (Moderators):** Full access to `.reply`, `.close`, and `.snooze`. 
- **Tier 3 (Admins):** Can access `.logs`, unblock users, and manage canned responses.

**Implementation:**
Use the permission system in `config.json` to assign distinct `staffRoleIds`. You can write a custom plugin to restrict certain commands based on role IDs.

## 2. Dynamic Canned Responses

Canned responses are a massive time-saver. Beyond static text, you can leverage variables to make them feel personal.

**Example Canned Responses:**
- `welcome`: `Hello {user.name}! Welcome to {server.name} support. A {moderator.name} will be with you shortly.`
- `escalate`: `Thanks for reaching out, {user.name}. I'm escalating Ticket #{ticket.id} to our admins.`

## 3. Customizing the Cards (UI)

Aaron's Support uses Discord's modern **Components V2 API** for rendering beautiful "Cards" instead of legacy embeds. 

You can tweak colors in your `config.json` to match your brand:
```json
"colors": {
  "system": "#FF5555",
  "staff": "#5865F2",
  "member": "#43B581"
}
```
The internal code has also been enhanced to display clear, hierarchical Headers (`##`) and dividers (`***`), creating a seamless, advanced UI out of the box.

## 4. Writing Plugins

Plugins allow you to execute custom JavaScript when specific events occur. 

**Example: Auto-tagging a role on new tickets**
Create `plugins/tag-on-open.js`:
```javascript
export default function(bot) {
  bot.on('ticketOpen', async (ticket, channel) => {
    // Ping a specific role ID when a ticket is opened
    await channel.send("<@&123456789012345678> A new ticket has arrived!");
  });
}
```

## 5. Reverse Proxy for Web Logs

For the web viewer (`docs/oauth.md`), we highly recommend running it behind a reverse proxy like **Nginx** or **Caddy** with SSL (HTTPS) enabled. This ensures that session cookies are secure.

**Caddyfile Example:**
```caddy
modmail.yourdomain.com {
    reverse_proxy localhost:3000
}
```

Enjoy your advanced modmail experience! If you create any cool plugins, consider sharing them on our GitHub!

// Shared by authorization, help, and the generated command documentation.
const groups = {
  1: {
    selfcontact: ['Open a conversation with yourself.', ''], about: ['About this bot.', ''],
    changelog: ['Show release notes.', ''], help: ['Browse commands or detailed help.', '[command|page]'], sponsors: ['Show project sponsorship information.', ''],
  },
  2: {
    adduser: ['Add a participant; announce your display name.', '<member ID>'], anonadduser: ['Add a participant anonymously.', '<member ID>'],
    removeuser: ['Remove an added participant; announce your display name.', '<member ID>'], anonremoveuser: ['Remove an added participant anonymously.', '<member ID>'],
    reply: ['Send a reply with your server display name.', '<text>'], areply: ['Send an anonymous reply.', '<text>'], anonreply: ['Alias for an anonymous reply.', '<text>'],
    preply: ['Send a named, unboxed text reply using Components V2.', '<text>'], pareply: ['Send an anonymous, unboxed reply.', '<text>'],
    freply: ['Send a named reply with template variables.', '<text>'], fareply: ['Send an anonymous reply with variables.', '<text>'],
    fpreply: ['Send a named, unboxed reply with variables.', '<text>'], fpareply: ['Send an anonymous, unboxed reply with variables.', '<text>'],
    close: ['Close now or schedule closure (1s–30d). Replies do not cancel timers.', '[now|duration] [reason]'], cancelclose: ['Cancel scheduled closure.', ''],
    contact: ['Start a conversation with a server member.', '<member ID> [opening message]'],
    delete: ['Delete a relayed staff reply or internal note by source/relay ID.', '<message ID>'], edit: ['Edit a staff reply or note; preserve its original anonymity and format.', '<message ID> <text>'],
    loglink: ['Get a private live log URL or create a current archive snapshot.', ''], logs: ['Search member history, optionally filtering message text.', '[member ID] [page] [search text]'],
    history: ['List member history.', '[member ID] [page]'], log: ['Download a closed conversation archive.', '<ticket number>'],
    msglink: ['Find a source or staff copy in this conversation.', '<message ID>'], note: ['Save an internal staff note.', '<text>'],
    notify: ['Mention yourself, a staff user, or staff role on the next member message.', '[user/role mention]'], unnotify: ['Remove a one-time notification.', '[user/role mention]'],
    subscribe: ['Notify on every member message.', '[user/role mention]'], unsubscribe: ['Remove a recurring subscription.', '[user/role mention]'],
    nsfw: ['Mark the staff channel as age-restricted.', ''], sfw: ['Remove the age-restricted flag.', ''],
    repair: ['Recreate/repair this ticket channel and replay its conversation to staff.', '[ticket number]'],
    snippet: ['Send, add, edit, delete, or list anonymous canned replies. Editing requires level 3.', '[name|list|add <name> <text>|set <name> <text>|delete <name>]'], snippets: ['List canned replies.', ''],
    snooze: ['Queue incoming DMs, optionally until a specified duration.', '[duration]'], snoozed: ['List snoozed tickets.', '[page]'],
    unsnooze: ['Restore a conversation and replay queued DMs.', '[ticket number]'], title: ['Rename the private channel.', '<title>'], retry: ['Retry failed deliveries without duplicating successful copies.', '<message ID>'],
  },
  3: {
    block: ['Block a user or role from incoming modmail.', '<user ID|role mention> [reason]'], blocked: ['List blocked users and roles.', '[page]'], unblock: ['Unblock a user or role.', '<user ID|role mention>'],
    move: ['Move the staff channel to a private category.', '<category ID>'], alias: ['Manage command shortcuts and sequences separated by &&.', '[list|add <name> <commands separated by &&>|set <name> <commands>|delete <name>]'], aliases: ['List command shortcuts.', ''],
  },
  4: {
    disable: ['Disable new conversations or all incoming/outgoing DMs.', '<new|all>'], enable: ['Enable all DM functions.', ''], isenable: ['Show the current DM mode.', ''],
    activity: ['Set activity type and text.', '<Playing|Listening|Watching|Competing> <text>'], config: ['View or set runtime configuration with JSON values.', '[key JSON-value]'],
    mention: ['Choose a staff role/user to notify on new tickets, or turn it off.', '<role/user mention|off>'], permissions: ['View command permission levels. Changing them requires level 5.', '[command <name> <2-5>|role <role ID> <2-5>|reset <name>]'],
    ping: ['Show Discord Gateway latency.', ''], prefix: ['Change the command prefix.', '<prefix>'], status: ['Set the online/idle/dnd/invisible presence.', '<online|idle|dnd|invisible>'],
  },
  5: {
    clearsnoozed: ['Preview all snoozed tickets and confirm before waking them.', ''], setup: ['Create or verify a private category and log channel.', ''],
    autotrigger: ['Manage first-message keyword → snippet rules.', '[list|set <name> <keyword> <snippet>|delete <name>]'],
    debug: ['View recent sanitized operational events (no message bodies or tokens).', ''],
    oauth: ['Inspect OAuth log-viewer setup, login URL, or revoke viewer sessions.', '[status|logoutall]'],
    update: ['Install GitHub main on Pterodactyl, or check the latest revision. Restart from the panel after installing.', '[check]'],
    plugins: ['Manage trusted local JavaScript plugins.', '[list|load <name>|unload <name>|reload <name>]'],
  },
};
export const commands = Object.fromEntries(Object.entries(groups).flatMap(([level, values]) => Object.entries(values).map(([name, [description, usage]]) => [name, { name, level: Number(level), description, usage }])));
export const replyCommands = new Set(['reply','areply','anonreply','preply','pareply','freply','fareply','fpreply','fpareply']);
export function replyOptions(name, config) { return { anonymous: config.alwaysAnonymous || ['areply','anonreply','pareply','fareply','fpareply'].includes(name), plain: ['preply','pareply','fpreply','fpareply'].includes(name), formatted: name.startsWith('f') }; }

# Configure your inbox

## Permission levels

| Level | Default access |
| --- | --- |
| 1 | Server members: help, about, changelog, sponsors, selfcontact |
| 2 | Staff roles: conversations, replies, participants, logs, snoozing, notifications |
| 3 | Senior staff: blocks, moves, alias and snippet management |
| 4 | Discord administrators and admin roles: availability, presence, configuration |
| 5 | Server owner, ownerUserIds, or roles explicitly assigned 5: setup, plugins, permissions changes, OAuth sessions, diagnostics |

The configured `staffRoleIds` default to level 2; `adminRoleIds` default to level 4. Additional roles are mapped through `permissionRoles`. Owners are set in `ownerUserIds`, and the server owner always has level 5. Every staff role has access to every inbox conversation and archive; these levels control commands, not per-conversation confidentiality.

```text
.permissions role 123456789012345678 3
.permissions command close 3
.permissions reset close
.permissions role 123456789012345678 remove
```

Only level 5 can change mappings. Command overrides can raise the listed minimum level. Role changes are applied to configured category/log/live-channel overwrites. Removing a role from `permissionRoles` does not revoke access it still has through `staffRoleIds` or `adminRoleIds`.

Commands, aliases, help buttons, and confirmation buttons all use current membership and the same authorization checks. Plugins declare their command's required level.

## Configuration keys

| Key | Default / meaning |
| --- | --- |
| guildId | The one server served by this bot |
| categoryId, logChannelId | Existing private IDs, or null for `.setup` |
| staffRoleIds, adminRoleIds | Staff and administrator role IDs |
| ownerUserIds, permissionRoles, commandLevels | Owner IDs, role levels, raised command levels |
| prefix | `.` |
| status, statusType | Activity text and Playing/Listening/Watching/Competing |
| presenceStatus | online / idle / dnd / invisible |
| colors | member, staff, system: #RRGGBB colors |
| alwaysAnonymous | false; set true to make all staff reply variants anonymous |
| minAccountAgeHours, minMemberAgeHours | 168 hours old, 24 hours in the server; use 0 to disable either age rule |
| messageCooldownSeconds | 2 seconds between member messages |
| maxAttachmentBytes | 8388608 maximum combined bytes per message |
| maxOpenTickets | 100; still subject to Discord channel/category limits |
| dmMode | enabled, new (block new tickets), all (block DM relays) |
| snoozeMode | queue (save until resumed) or wake (new DM wakes conversation) |
| snoozedCategoryId | Optional private category used while snoozed |
| mention | null or an approved staff notification target |
| snippets, aliases, autotrigger | Canned replies, shortcuts, first-message rules |
| enabledPlugins | Trusted plugin folder names to load at startup |
| welcomeMessage, closeMessage | Member-facing lifecycle notices |

Runtime commands persist changes in SQLite and override matching file values after restart. Use `.config` to list editable keys, `.config key` to inspect one, and `.config key JSON-value` to update it. IDs, owners, and structural settings belong in the host configuration or their dedicated commands.

```text
.prefix .
.activity Watching DMs for the moderation team
.status idle
.config colors {"member":"#5865F2","staff":"#57F287","system":"#FEE75C"}
.config alwaysAnonymous true
.config snoozeMode "wake"
```

## Replies and variables

| Variant | Identity | Layout | Variables |
| --- | --- | --- | --- |
| reply | Moderator display name | Container card | No |
| areply / anonreply | Moderation team | Container card | No |
| preply | Moderator display name | Unboxed text | No |
| pareply | Moderation team | Unboxed text | No |
| freply | Moderator display name | Container card | Yes |
| fareply | Moderation team | Container card | Yes |
| fpreply | Moderator display name | Unboxed text | Yes |
| fpareply | Moderation team | Unboxed text | Yes |

Supported variables: `{user.name}`, `{user.id}`, `{moderator.name}`, `{server.name}`, `{ticket.id}`. Anonymous variants substitute Moderation team for the moderator name. Unknown variables remain literal. Snippets are anonymous replies. Ordinary staff messages stay in the channel; use `.note` to save internal discussion in the audit log. `.r` and `.ar` are shortcuts for `.reply` and `.areply`.

The audit log retains the real moderator identity for every format. Names, variables, message bodies, and displayed attachment names pass through mention removal. `@handle` removal is deliberately conservative and also removes the domain portion of email-like text. It never enables Discord mention parsing.

## Participants

`.adduser` and `.anonadduser` add a server member to the shared conversation. The member receives a notice that future messages are shared. Staff replies reach all current participants; member DMs reach staff and the other participants. Old messages are never replayed to added members. A member can participate in only one active conversation; at most ten members share a ticket.

`.removeuser` and `.anonremoveuser` remove an added participant. Closing the ticket ends the original member's participation. History includes conversations in which a user was an added participant.

## Notifications and snoozing

`.notify` mentions a staff user/role for the next member message; `.subscribe` does so for each message. With no argument the target is yourself. `.unnotify` and `.unsubscribe` remove them. A current staff permission check runs before each notification. Configure the bot's Mention Everyone permission in a private channel only if you need it to notify a non-mentionable staff role; no user-supplied mentions are allowed.

`.mention` sets an opening notification, or use `.mention off`. Member-provided text is redacted before the notification is composed, so it cannot add ping recipients.

`.snooze 2h` saves incoming messages and their edits/deletes to SQLite. `.unsnooze` restores the channel and replays undeleted queued messages. In wake mode, a new DM resumes the ticket automatically. Timed snooze and closure persist through restarts. Replies never cancel scheduled closure. `.clearsnoozed` requires an owner-bound, expiring confirmation before waking the tickets listed in that confirmation.

## Availability and first-message rules

`.disable new` blocks new tickets but keeps existing conversations running. `.disable all` blocks member intake and outgoing DM relays. `.enable` restores them; `.isenable` shows the mode. Synchronizing an existing message's edits/deletions remains available for privacy and corrections.

```text
.snippet add welcome Thanks for contacting the team. Please describe the problem.
.autotrigger set greeting help welcome
.alias add urgent areply A moderator will be with you shortly.
.alias add thanks areply Thanks for contacting support. && close 1h
```

Autotriggers match a literal, case-insensitive keyword in the first message of a new conversation. Only the first matching rule sends its configured snippet. They cannot execute arbitrary privileged commands. Aliases expand into up to ten built-in commands separated by `&&`, with optional preset arguments. Permissions for every step are checked before execution and rechecked during it; a failure stops the sequence. Extra arguments supplied to the alias are appended to its first command. Use `.snippet name` or `.name` to send a saved anonymous reply. Alias names take precedence over snippet names.

# Frequently asked questions

## Why won’t the bot open a thread?

Check that it is online, the member is in your server, and their DMs are enabled. The default rules require an account age of seven days and 24 hours of membership. Blocks and `.disable` can also prevent new threads.

Run `.isenable` to check availability. Check `.blocked` and the `minAccountAgeHours` and `minMemberAgeHours` settings. The console should show `Ready: moderator inbox for server ...` after a successful start.

## Why can’t staff see or use the commands?

Put the correct role IDs in `staffRoleIds`, or in Pterodactyl’s **Staff Role IDs** variable. Staff default to permission level 2. Use `.permissions` to inspect your level and command overrides.

Most commands belong inside the private thread or log channel. Setup and informational commands can be used elsewhere. See [permission levels](configuration.html#permission-levels).

## How do I keep a message staff-only?

Use `.note your message`. Ordinary messages in a modmail channel are sent to the member as anonymous replies.

## What happens to mentions?

The bot replaces member and staff mention text with `[REMOVED_PING]` before saving and relaying it:

```text
Sent: @everyone 67
Seen: [REMOVED_PING] 67
```

This covers user and role mentions, `@everyone`, `@here`, and written `@handles`. It also removes the domain portion of email-like text. Staff notification commands use their own approved targets.

## Why didn’t a reply cancel the close timer?

Scheduled closures stay active until staff use `.cancelclose`. The timer survives a restart. See [closing a thread](usage.html#closing-a-thread).

## Does the bot support stickers or voice messages?

Images and ordinary file attachments, including audio files, are relayed. Stickers, reactions, polls, forwarded message snapshots, and native voice-message playback are not mirrored.

## Where are the logs saved?

On your host, in the data directory. Closing a thread also uploads a ZIP to the private log channel. The ZIP contains a transcript, audit records, and downloaded attachments. Deleted content and the real moderator identities stay in the audit records.

The optional [OAuth viewer](oauth.html) serves logs from your bot host. The public documentation site contains no conversations.

## Can I use modmail-dev plugins?

Python plugins for modmail-dev do not run in this bot. Aaron’s Support loads local JavaScript modules. See the [plugin guide](plugins.html) for the API and example plugin.

## Why did my setting change after a restart?

Changes made with bot commands are saved in SQLite and override matching values in `config.json`. On Pterodactyl, nonempty Startup variables take precedence again when the server starts.

For example, leave **Prefix Override** blank if you want `.prefix` changes to persist. See [Pterodactyl Startup variables](pterodactyl.html#startup-variables).

## Can I run the bot for more than one server?

Each instance serves one Discord server. Use a separate bot token and data directory for each instance. Do not run two processes against the same token or database.

## What if a moderator deletes the channel by mistake?

The bot marks the thread as broken and queues new DMs. Run `.repair ticketNumber` from the private log channel to recreate it. See [recovery](operations.html#recovery) for failed deliveries and archive uploads.

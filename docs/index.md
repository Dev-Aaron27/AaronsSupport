# Introduction

Aaron’s Support is a self-hosted Discord modmail bot. Members send it a DM, and your moderators handle the conversation together in a private channel on your server.

## How it works

The first DM opens a staff channel in your inbox category. Messages and attachments are relayed between that channel and the member, so any moderator can pick up the conversation. Members see replies from the bot, without needing to contact a moderator’s personal account.

When staff close a conversation, the bot saves a transcript and posts it in your log channel. You can look up a member’s previous conversations with `.logs`.

We use **thread** to mean one modmail conversation. Each thread uses a regular Discord text channel, rather than Discord’s native thread feature.

## Features

- Named and anonymous replies, internal staff notes, and shared conversations with multiple members.
- Images and files, with edits and deletes synchronized between delivered messages.
- Saved transcripts and attachments, plus an optional log viewer with Discord login.
- Snippets, command aliases, notifications, and five permission levels.
- Account and membership age limits, user and role blocks, and mention removal.
- Timed closing and snoozing that survive a restart.
- Custom bot status, prefix, colors, opening messages, and local JavaScript plugins.

## Getting started

Start with [Choosing a host](choose-host.html) if you haven’t decided where to run the bot. If you already have Pterodactyl, [import the egg](pterodactyl.html) to install it through your panel.

The [installation guide](setup.html) covers creating the Discord application and running it with Docker or Node.js. Once it is online, follow the [usage guide](usage.html) to open a test thread, reply, and save its logs.

## Reading the commands

These docs use the default prefix, **`.`**. If you change your prefix, use that instead. Run `.help command` in Discord for help with a specific command.

Arguments in `<angle brackets>` are required. Arguments in `[square brackets]` are optional. Replace the brackets and their contents with your own value:

```text
.reply <text>
.close [now|duration] [reason]
```

For example, `.reply Thanks for letting us know.` sends a reply, and `.close 2h Resolved` schedules the thread to close in two hours.

## About the project

The [source code](https://github.com/Dev-Aaron27/AaronsSupport) is maintained in the Aaron’s Support repository. This bot runs on Node.js; plugins written for modmail-dev’s Python bot will need to be rewritten for [our plugin API](plugins.html).

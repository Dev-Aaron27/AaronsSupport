# Aaron’s Support

A self-hosted modmail bot for Discord. Give your moderation team a shared inbox where members can ask questions, send reports, and follow up privately.

Members DM the bot. Staff receive the conversation in a private server channel and reply through the bot’s account. When the conversation ends, the bot saves a transcript and posts it to your log channel.

[Documentation](docs/index.md) · [Pterodactyl setup](docs/pterodactyl.md) · [Report a bug](https://github.com/Dev-Aaron27/AaronsSupport/issues)

## Features

- **Shared inbox:** private staff channels, named or anonymous replies, internal notes, and conversations with multiple members.
- **Message relay:** text, images, and files, with synchronized edits and deletes.
- **Conversation history:** saved transcripts and attachments, member history search, and an optional log viewer with Discord login.
- **Staff tools:** canned replies, command aliases, notifications, snoozing, and scheduled closing.
- **Access controls:** five command permission levels, user and role blocks, and minimum account and membership ages.
- **Customization:** bot status, prefix, colors, welcome messages, and local JavaScript plugins.
- **Mention removal:** `@everyone 67` is relayed as `[REMOVED_PING] 67`.

The default prefix is **`.`**. Replies use Discord Components V2.

## Hosting

| Method | Requirements | Guide |
| --- | --- | --- |
| Pterodactyl | A Pterodactyl 1.x panel and the supplied Node.js 24 egg | [Panel setup](docs/pterodactyl.md) |
| Docker Compose | A host with Docker Engine and Compose | [Docker installation](docs/setup.md#docker-compose) |
| Node.js | Node.js 24 or newer and a process manager | [Node installation](docs/setup.md#run-with-node) |

Run one instance per Discord server, bot token, and data directory.

## Install with Pterodactyl

1. Import [egg-aarons-support.json](deploy/pterodactyl/egg-aarons-support.json) through **Admin → Nests → Import Egg**.
2. Create a server using the egg’s Node.js 24 image.
3. Enter the bot token, Discord server ID, and staff role IDs in **Startup**.
4. Start the server, then run `.setup` in Discord as the server owner.

The egg installs the application and dependencies. Configuration, conversation data, and custom plugins survive reinstalls. The [Pterodactyl guide](docs/pterodactyl.md) covers backups and the optional log viewer.

## Install with Docker

Create a bot in the [Discord Developer Portal](https://discord.com/developers/applications), enable **Message Content Intent**, and invite it with the permissions in the [installation guide](docs/setup.md#discord-application).

```sh
git clone https://github.com/Dev-Aaron27/AaronsSupport.git
cd AaronsSupport
cp .env.example .env
cp config.example.json config.json
```

Set `DISCORD_TOKEN` in `.env`, then set `guildId` and `staffRoleIds` in `config.json`. Leave `categoryId` and `logChannelId` as `null` to let `.setup` create them.

```sh
docker compose up -d --build
```

Once the bot is online, run `.setup` as the server owner. See the [installation guide](docs/setup.md) for existing channels, direct Node hosting, and file permissions.

## Using the bot

| Command | Purpose |
| --- | --- |
| `.reply <text>` | Reply with your server display name |
| `.areply <text>` | Reply as “Moderation team” |
| `.note <text>` | Leave a note for staff |
| `.close` | Close the thread and save its logs |
| `.close 2h [reason]` | Schedule closure in two hours |
| `.logs [member ID]` | Look up a member’s conversations |
| `.help [command]` | Browse commands or check their usage |

**Only reply commands and snippets send messages to members.** Ordinary staff messages stay in the channel. Use `.note` to save staff-only discussion in the conversation log. Scheduled closes stay active until you use `.cancelclose`.

The [usage guide](docs/usage.md) covers replies, attachments, snippets, participants, and notifications.

## Documentation

- [Choosing a host](docs/choose-host.md)
- [Installation](docs/setup.md)
- [Configuration and permissions](docs/configuration.md)
- [Plugins](docs/plugins.md)
- [Log viewer](docs/oauth.md)
- [Backups and updates](docs/operations.md)
- [Frequently asked questions](docs/faq.md)

## Conversation data

Conversations, attachments, and archives are stored on your host. Audit records include internal notes, moderator identities, and deleted content. Keep backups private and let members know your retention policy. The optional web viewer checks staff membership before granting access.

## Contributing and support

Bug reports, documentation fixes, and feature suggestions are welcome through [GitHub Issues](https://github.com/Dev-Aaron27/AaronsSupport/issues). Include the command or action involved and relevant console output, with private information removed.

For development setup, automated checks, documentation builds, and egg packaging, see [CONTRIBUTING.md](CONTRIBUTING.md).

# Aaron’s Support

[![Discord](https://img.shields.io/badge/Discord-Modmail-5865F2?style=for-the-badge&logo=discord&logoColor=white)](https://github.com/Dev-Aaron27/AaronsSupport)
[![Node.js](https://img.shields.io/badge/Node.js-24.x-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge)](https://opensource.org/licenses/MIT)

> **A self-hosted modmail bot for Discord.** Give your moderation team a shared inbox where members can ask questions, send reports, and follow up privately.

Members DM the bot, and staff receive the conversation in a private server channel. Staff can reply seamlessly through the bot’s account. When the conversation concludes, the bot saves a clean transcript and posts it to your log channel.

[📚 Documentation](docs/index.md) &nbsp;·&nbsp; [🚀 Pterodactyl Setup](docs/pterodactyl.md) &nbsp;·&nbsp; [🐛 Report a Bug](https://github.com/Dev-Aaron27/AaronsSupport/issues)

---

## ✨ Features

- 🔒 **Shared inbox:** Private staff channels, named/anonymous replies, internal notes, and conversations with multiple members.
- 📎 **Message relay:** Fully synced text, images, and files, including edits and deletes.
- 🗄️ **Conversation history:** Saved transcripts, member history search, and an optional **log viewer with Discord login**.
- 🛠️ **Staff tools:** Canned replies, command aliases, notifications, snoozing, and scheduled auto-closing.
- 🛡️ **Access controls:** Five command permission levels, user/role blocks, and minimum account age checks.
- 🎨 **Customization:** Bot status, prefix, custom colors, welcome messages, and local JavaScript plugins.
- 🧹 **Mention removal:** Automatically neutralizes mentions like `@everyone 67` into `[REMOVED_PING] 67`.

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

## 📚 Documentation

- [Advanced Usage & Workflows](docs/advanced-usage.md)
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

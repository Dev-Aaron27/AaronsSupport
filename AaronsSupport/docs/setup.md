# Installation

## Discord application

Create an application in the [Discord Developer Portal](https://discord.com/developers/applications). Save its Bot token privately and enable **Message Content Intent**. Server Members and Presence privileged intents are not required.

Invite the application using the `bot` OAuth scope and these permissions:

- View Channels, Send Messages, Read Message History.
- Attach Files and Embed Links (Discord uses attachment/link permissions for rich components).
- Manage Channels, Manage Roles, Manage Messages, and Add Reactions.

Manage Roles is required to update channel permission overwrites. In channel settings Discord calls this **Manage Permissions**. Manage Messages lets the bot remove staff reply commands and lets `.delete` remove bot copies. Add Reactions enables the member delivery checkmark. Administrator permission is not required.

Enable Developer Mode in Discord settings to copy server, category, channel, role, and user IDs.

## Download the source

Clone the repository on your host, then enter its folder:

```sh
git clone https://github.com/Dev-Aaron27/AaronsSupport.git
cd AaronsSupport
```

If you are using the Pterodactyl egg, follow the [panel guide](pterodactyl.md) instead. It installs the source and dependencies for you.

## Configuration

```sh
cp .env.example .env
cp config.example.json config.json
```

Set `DISCORD_TOKEN` in `.env`. Fill in `guildId` and `staffRoleIds` in `config.json`. The default prefix is `.`. Keep both files private; they are ignored by Git.

For automatic setup, use `null` for `categoryId` and `logChannelId`. Start the bot and run `.setup` in your server as its owner or a configured level 5 owner. The bot creates a private category and log channel and saves their IDs in SQLite. Only informational commands and setup are available outside the private inbox/log channels.

Alternatively, supply existing category and log text-channel IDs. Deny View Channel for everyone and all non-staff roles; allow configured staff roles and the bot. Permit the bot's required permissions in the category. The bot refuses to send private content into channels visible to unapproved roles. Discord Administrators always bypass channel permission overwrites.

Discord permits 50 channels in one category. A log channel in the same category uses one slot.

## Pterodactyl hosting

Use the [Pterodactyl egg and panel guide](pterodactyl.md) to create preinstalled servers with persistent data and Startup variables. The self-contained egg includes the application source; no GitHub login is needed.

## Docker Compose

Install [Docker Engine and Compose](https://docs.docker.com/engine/install/), then:

```sh
docker compose up -d --build
docker compose logs -f modmail
```

Wait for `Ready: moderator inbox for server ...`. The container runs as UID 1000 with a read-only root filesystem. SQLite, attachments, archives, and runtime settings live in the persistent `inbox-data` volume. Your local `plugins` directory is mounted read-only.

Configuration and plugins must be readable by UID 1000 inside the container. On a host with different ownership, grant read access to these non-token files. The token is passed through Compose's environment file, not mounted into the image.

```sh
docker compose restart modmail
docker compose down
```

Do not use `down -v` unless intentionally deleting all conversation data. Run one bot process for each token/data directory. Outbound HTTPS and Discord Gateway WebSocket access are required. The bot needs no inbound port unless you enable the optional log viewer.

## Run with Node

Install Node.js 24 or newer, then run:

```sh
npm ci
npm start
```

Environment variables: `DISCORD_TOKEN`, `CONFIG_PATH` (default `./config.json`), `DATA_DIR` (default `./data`), and `PLUGIN_DIR` (default `./plugins`). Use a process manager for restart-on-failure behavior.

## Start using the inbox

Run `.selfcontact` in Discord to open a conversation with yourself. Send a reply with `.reply`, then close it with `.close` to save the transcript in your log channel.

The [usage guide](usage.md) covers the commands staff use day to day.

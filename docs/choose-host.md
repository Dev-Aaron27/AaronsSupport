# Choosing a host

The bot needs to stay running to receive DMs. Choose a host that supports Node.js 24 or Docker and has enough disk space for your conversations and attachments.

## Pterodactyl

If you already use a Pterodactyl panel, this is the simplest option. Import the supplied egg, create a server, and enter your token, server ID, and staff role IDs in the Startup tab. The installer handles the application and dependencies.

Your configuration, logs, and plugins are kept outside the managed application folder, so they survive a reinstall. Panel backups can save them together.

[Set up Pterodactyl hosting](pterodactyl.html)

## Docker Compose

Use Docker Compose on a VPS or a computer you leave running. The repository includes the Dockerfile and Compose configuration. Conversation data lives in a persistent volume.

You manage updates, backups, and service restarts on the host. Docker’s restart policy restarts the bot after a crash or host reboot.

[Install with Docker Compose](setup.html#docker-compose)

## Node.js

You can also run the bot directly with Node.js 24 or newer. Install the dependencies with `npm ci`, then start it with `npm start`.

Use a process manager to restart it after failures and start it when your host boots. Keep the data directory on persistent storage.

[Install with Node.js](setup.html#run-with-node-js)

## What your host needs

| Requirement | Details |
| --- | --- |
| Runtime | Node.js 24+, or Docker with the supplied image |
| Network | Outbound HTTPS and Discord Gateway WebSocket access |
| Storage | Persistent disk for SQLite, attachments, and archives |
| Starting allocation | 512 MiB RAM, 1 CPU core, and 2 GiB disk; increase for your workload |
| Public web address | Only needed for the optional OAuth log viewer |

The resource allocation is a starting point, not a capacity guarantee. Attachment storage grows as people use the bot.

Run one process per bot token and data directory. A host that sleeps when idle will leave the bot offline; missed DMs are not backfilled when it wakes up.

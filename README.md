# Aaron’s Support

An advanced, self-hosted Discord modmail bot with a private shared inbox, Components V2 throughout, SQLite persistence, and a default `.` prefix.

## Features

- Private staff channels, shared participants, named/anonymous replies, plain/formatted variants, internal notes, and canned replies.
- Mention redaction: `@everyone 67` becomes `[REMOVED_PING] 67`. User-provided mentions never ping staff or participants.
- Text/image/file relay, synchronized edits/deletes, per-recipient retry tracking, complete local attachment archives, and private log links.
- Five command permission levels; command aliases, role/user blocks, account/join-age gates, availability controls, notification subscriptions, and channel repair.
- Persistent snoozing, queued-message replay, scheduled closure, confirmed bulk unsnooze, and first-message snippet triggers.
- Trusted local JavaScript plugins with commands, lifecycle hooks, and namespaced storage.
- Optional Discord OAuth log viewer. Public documentation is built for GitHub Pages; private conversations stay on your host and in Discord.

## Quick start

Requires Docker Compose, or Node.js 24+ for a direct deployment.

```sh
cp .env.example .env
cp config.example.json config.json
# Set your token in .env, and guildId/staffRoleIds in config.json.
docker compose up -d --build
```

Enable Message Content Intent and invite the bot with the permissions in the [setup guide](docs/setup.md). With category/log IDs set to null, the server owner can run `.setup` to create them. Run `.help` to browse commands with permission-aware buttons.

**Ordinary staff messages are anonymous replies.** Use `.reply` for a moderator display name, `.areply` for anonymity, and `.note` for internal discussion. Set `alwaysAnonymous` to true to make every staff reply anonymous.

## Pterodactyl

Import [egg-aarons-support.json](deploy/pterodactyl/egg-aarons-support.json) to provision preinstalled servers on Node.js 24. The egg includes the application bundle, so no GitHub credentials or source download is needed. Set the token, server ID, and staff role IDs in Startup, then run `.setup` in Discord. See the [panel hosting guide](docs/pterodactyl.md) for persistent data, optional OAuth, and reinstall instructions.

Maintainers regenerate the egg with `npm run pterodactyl:build`.

## Documentation

- [Introduction](docs/index.md)
- [Choosing a host](docs/choose-host.md)
- [Usage guide](docs/usage.md)
- [Frequently asked questions](docs/faq.md)
- [Setup and deployment](docs/setup.md)
- [Configuration and permissions](docs/configuration.md)
- [Plugin development](docs/plugins.md)
- [OAuth log viewer](docs/oauth.md)
- [Backups, recovery, updates, and GitHub Pages](docs/operations.md)

Build the searchable command reference and complete site with `npm run docs:build`. The Pages workflow deploys `_site` when changes reach main. Enable **Settings → Pages → GitHub Actions** first. The expected URL is `https://dev-aaron27.github.io/AaronsSupport/`; deployment is not performed by a local docs build.

## Development

```sh
npm ci
npm run check
npm test
npm run docs:build
npm audit --omit=dev
```

Tests cover routing, mention removal, message revisions, participant fan-out, retries, snooze persistence, permissions, confirmation flows, plugins, migration, and OAuth access controls. Live Discord Gateway delivery and OAuth consent still require a configured real application/server.

Run one instance against a persistent data directory. Back up before upgrading. Archives retain deleted messages and staff identities; make your retention policy clear to members. `.update check` checks release metadata and gives host update instructions; it does not update the running process from chat.

This is a JavaScript implementation for this repository. Python plugins from modmail-dev are not compatible.

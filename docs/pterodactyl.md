# Pterodactyl hosting

Import `egg-aarons-support.json` into Pterodactyl 1.x to create servers with the bot already installed. The egg includes the source code and installs its dependencies automatically. Your host needs access to the container and npm registries during installation.

The runtime uses **ghcr.io/parkervcp/yolks:nodejs_24**, and the installer uses **node:24-bookworm-slim**. Use Node.js 24 or newer; earlier images do not provide the SQLite API used by this bot.

[Download the importable egg](downloads/egg-aarons-support.json)

## Import and create a server

1. Open the Pterodactyl **Admin** area, then **Nests → Import Egg**. Choose an existing Bot nest, or create one, and upload `egg-aarons-support.json`.
2. Create a server in that nest using **Aaron's Support — Discord Modmail (Node.js 24)**. Keep the egg's startup command and Node.js 24 image.
3. Start with **512 MiB RAM**, **1 CPU core**, and **2 GiB disk**. Increase disk and RAM for large inboxes/archives. Use no swap unless your host requires it. These are suggested starting allocations, not measured capacity guarantees.
4. Assign a primary allocation; Pterodactyl requires one even when the bot does not listen on a port. The allocation is only used if you enable the optional private log viewer.
5. Fill in the three required Startup variables: **Discord Bot Token**, **Discord Server ID**, and **Staff Role IDs**. Role lists accept comma-separated IDs.
6. Wait for installation to finish, then start the server. A ready bot prints `Ready: moderator inbox for server ...` and the panel marks it running.
7. With category/log variables blank, run `.setup` in Discord as the server owner or a configured bot owner. It creates the private category and log channel. Test a DM and staff reply before opening it to members.

Enable Message Content Intent and give the bot the permissions in the [Discord setup guide](setup.html). The default command prefix is **`.`**.

The startup command is fixed and contains no credentials:

```sh
exec node app/scripts/pterodactyl-start.js
```

The bot handles both SIGINT and SIGTERM to drain work and close SQLite. The egg's `^C` stop action uses the normal signal path; it does not type a command into the bot console.

## Startup variables

| Variable | Purpose |
| --- | --- |
| DISCORD_TOKEN | Required bot token; environment only |
| MODMAIL_GUILD_ID | Required Discord server ID |
| MODMAIL_STAFF_ROLE_IDS | Required moderator role IDs; level 2 |
| MODMAIL_ADMIN_ROLE_IDS | Optional level 4 role IDs |
| MODMAIL_OWNER_USER_IDS | Optional extra level 5 user IDs; server owner already has level 5 |
| MODMAIL_CATEGORY_ID | Optional existing private inbox category |
| MODMAIL_LOG_CHANNEL_ID | Optional existing private log text channel |
| MODMAIL_PREFIX | Optional forced prefix; blank keeps the normal default/saved setting |
| LOG_VIEWER_URL | Optional public HTTPS origin for private logs |
| DISCORD_CLIENT_ID | OAuth application ID, only needed for the viewer |
| DISCORD_CLIENT_SECRET | OAuth secret, only needed for the viewer |

Nonempty panel values override config.json and matching saved runtime settings **on startup**. Blank optional values leave saved configuration in control. Use `none` in the optional admin/owner lists to force an empty list. Keep Prefix Override blank to retain `.prefix` command changes across restarts. Required guild/staff values always come from the panel.

The first start writes a valid config.json using your panel settings. Later starts preserve that file; advanced settings can be edited through the file manager or the normal bot commands. An invalid JSON file is reported rather than overwritten. No token or OAuth secret is written into config.json or bundled in the egg.

Pterodactyl's Startup settings are not a secret vault: administrators and users with permission to view startup variables may see tokens. Restrict those permissions and never put secrets in the startup command, a public egg export, or screenshots. The `.env` file is not loaded by this egg; use the panel variables.

## Persistent layout

```text
/home/container/
  app/             # managed application and node_modules
  config.json      # advanced configuration, created on first start
  data/            # SQLite, attachment copies, archives and runtime settings
  plugins/         # trusted custom plugins plus the seeded example plugin
```

Wings mounts this same server volume at `/mnt/server` during installation. The installer adopts the server directory's ownership rather than hard-coding a user ID. Existing data, config, `.env`, and custom plugins are preserved on reinstall. Dependencies and application code are prepared before replacing app/. The installer refuses to replace an existing app/ without its ownership marker, so another application's folder is not silently overwritten.

Use the **Reinstall** action with an updated egg to install a newer bundled version. Back up first. Importing a newer egg does not update existing server files by itself. If your panel imports it as a new egg, select that egg for the server before reinstalling. Keep the startup command and image aligned with the selected egg. Do not upload edits inside app/ that you need to retain; keep plugins in the top-level plugins/ directory.

## Optional OAuth log viewer

Set LOG_VIEWER_URL to your public HTTPS origin, and set both OAuth client variables. Register the exact `/callback` URL in the Discord Developer Portal. The wrapper binds the viewer to **0.0.0.0 on the primary SERVER_PORT allocation**, provided by Wings. Do not hard-code port 8787 or the public domain's port into the startup command.

Point an HTTPS reverse proxy at that allocation. A Pterodactyl allocation supplies a TCP endpoint, not an HTTPS certificate. Restrict the raw HTTP allocation to your proxy where possible; clients should use the HTTPS hostname. The bot's DM functionality uses outbound connections and does not require this viewer to be enabled. Leave LOG_VIEWER_URL blank to disable it.

See [OAuth authentication and access rules](oauth.html). Never host private logs on the public GitHub Pages docs site.

## Backups and migration

Stop the server, then use panel backups or copy **config.json, data/, and plugins/** together. Save the panel's environment settings separately in your secret manager. Restore them into the same layout before starting one bot process. Never share the same data directory/token across simultaneously running servers.

Archives currently store absolute local paths. If migrating from Docker's `/app/data` or another host path, update `tickets.archive_path` to point to the matching files under `/home/container/data/archives/` in an offline copy of the SQLite database. Keep a pre-migration backup; verify `.log` for a closed ticket before reopening the bot to members. New Pterodactyl servers and reinstalls already use the correct path.

## Regenerate the egg

Maintainers with Node.js 24 and GNU tar can package the current working tree:

```sh
npm run pterodactyl:build
```

This writes the importable egg, a separate application archive, and SHA256SUMS under deploy/pterodactyl/. The egg's installation script checks its embedded archive checksum before extraction. The separate archive is provided for inspection/manual distribution; you only need the JSON egg for normal panel installation. The build is deterministic for identical inputs and includes only an explicit source/config-example/docs allowlist. Runtime config, data, tokens, node_modules and custom plugins are excluded.

The repository's CI rebuilds the egg and checks that the committed JSON and checksums match the source. Rebuild whenever changing bundled application files or documentation. Review eggs before importing: an egg's installation script runs in the installer container with access to the server volume.

## Troubleshooting

- **Installation cannot download dependencies:** allow outbound access to the npm registry and the selected image registries, then retry installation. A failed dependency install leaves the existing app/ in place.
- **Set guildId/staffRoleIds errors:** copy numeric Discord IDs, not names or mentions. The everyone role cannot be a staff role.
- **Missing Message Content intent:** enable it in the Discord Developer Portal and restart.
- **Bot stays starting:** read its console. It reports ready only after Discord login and permission checks complete. Repair private category/log permissions or clear the optional IDs and use `.setup`.
- **File permission errors:** check the server volume's ownership in Wings. The runtime user must be able to write config.json, data/, and plugins/.
- **Viewer missing allocation/OAuth errors:** use a valid primary allocation, complete both OAuth variables, and configure HTTPS forwarding; or leave LOG_VIEWER_URL blank.
- **Memory limit reached:** increase RAM for your workload and inspect archive/attachment usage.

## Further reading

- [Pterodactyl panel](https://github.com/pterodactyl/panel)
- [Node.js 24 runtime image](https://github.com/parkervcp/yolks/tree/master/nodejs/24)

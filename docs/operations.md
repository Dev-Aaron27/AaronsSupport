# Backups and updates

## Backing up

Back up the entire data directory: inbox.sqlite and its journal/WAL files, attachments, and archives. Runtime settings, participants, message-copy IDs, subscriptions, and plugin data are stored in SQLite. Stop the bot before copying to get a consistent backup.

```sh
mkdir -p backups
docker compose stop modmail
docker compose run --rm --no-deps --user 0 --entrypoint tar \
  -v "$PWD/backups:/backup" modmail -czf /backup/inbox-data.tgz -C /app/data .
docker compose start modmail
```

Restore into an empty data volume with the bot stopped, preserve ownership for UID 1000, restore the matching configuration, then start one instance. Keep the same absolute DATA_DIR when restoring: archive locations are stored as absolute paths. Keep tokens in your secret manager, separate from public source and docs.

## Archives and message retention

Each ZIP contains transcript.html, audit.json, and attachment files. Extract it before opening attachment links. Revisions, internal notes, deleted text, and removed attachments are retained for staff audit. New messages have mention text replaced before it is saved; original mention IDs are not retained in the message body. Historical version 1 content stays in its original audit record.

There is no automatic retention purge. Notify members of your retention policy and monitor disk usage. Closed archives are immutable. `.logs memberID page search-text` searches saved current message content within a member's conversation history. `.log ticketNumber` downloads a closed archive again.

Archives larger than 8 MiB are uploaded as numbered chunks. Join all chunks in filename order, then extract:

```sh
cat ticket-42.zip.[0-9]* > ticket-42.zip
```

In PowerShell, use System.IO.File to create the output stream and append the bytes of each part sorted by name; do not use text-mode concatenation for ZIP data.

Discord attachment download URLs expire. The stored log URL is a Discord message link; `.log` can reupload the local archive if a link or log message was removed.

## Recovery

The bot uploads the archive before deleting the staff channel. A failed upload or deletion leaves the ticket in closing state and retries every ten seconds. Repair the underlying permissions or disk problem; incoming replies stay paused during closure.

If a staff channel is deleted unexpectedly, the ticket becomes broken and new DMs are queued. Use `.repair ticketNumber` from the log channel to recreate the private channel and restore staff context. It does not resend old messages to participants.

Message delivery records track each recipient and split component message separately. `.retry sourceMessageID` retries missing copies; successful copies are not sent twice. A crash between Discord accepting a message and the database recording its ID can still cause an ambiguous delivery. Inspect the recipient before retrying an interrupted message. Partial archive upload retries may also leave duplicate log posts; completed posts are marked explicitly.

## Updates

`.update check` reads the latest published release metadata and provides host deployment instructions. It does not pull code or restart itself from chat. Review release notes, back up the data, update your checkout on the host, and rebuild:

```sh
docker compose up -d --build
```

Schema additions migrate existing version 1 data automatically. Back up before upgrading; rolling back application code is not a database downgrade procedure. Use `.changelog` for the summary and `.debug` for recent sanitized operational events. Exception bodies, tokens, and DM content are not included in debug output.

## Known limits

- One server and one running process per bot token/data directory.
- Ten attachments totaling at most 8 MiB per source message. Longer text is split into linked delivery records to fit Components V2 limits.
- Reactions, stickers, polls, forwarded message snapshots, and native voice-message playback are not mirrored. Ordinary audio attachments are supported.
- Discord does not replay all events after an extended outage. Missed offline messages or edits may need to be resent. There is no historical DM backfill.
- Native edit/delete synchronization applies while a ticket is active. Commands preserve the original reply identity/layout when editing. Editing a source message after changing the configured command prefix may require `.edit` instead.
- Snoozing preserves private channel permissions; it is not a per-moderator access control feature.
- `.disable all` pauses new relay delivery. Existing-message edit/delete synchronization remains available.

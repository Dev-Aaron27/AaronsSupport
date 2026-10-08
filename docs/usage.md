# Usage

Once the bot is online, members can DM it to open a thread. Your configured staff roles can read and reply in the private channel it creates.

## Open a test thread

Run `.selfcontact` in your server to open a conversation with yourself. You can also use `.contact` to start one with a member:

```text
.contact 123456789012345678 Hello, we’re following up on your report.
```

To check the normal member experience, use a non-staff account to DM the bot. By default, accounts need to be at least seven days old and have spent 24 hours in your server.

## Replying

Send these commands inside the member’s thread:

```text
.reply Thanks for the report. We’ll take a look.
.areply Thanks for the report. We’ll take a look.
```

`.reply` shows your server display name. `.areply` shows “Moderation team”. Both are sent from the bot’s account.

**A normal message in the staff channel is also sent to the member, anonymously.** Use `.note` for something only staff should see:

```text
.note Waiting for another moderator to review the attachment.
```

Attach images or files to your reply as you would to a normal Discord message. The `.preply` and `.pareply` variants use unboxed text; the `f` variants support [template variables](configuration.html#replies-and-variables).

## Editing and deleting

Member edits and deletes update their relayed copies while the thread is active. Staff can edit or delete a reply or note using its original message ID or a relayed copy’s ID:

```text
.edit 123456789012345678 We’ve reviewed your report and taken action.
.delete 123456789012345678
```

Editing preserves the reply’s original name, anonymity, and format. Deleted content is still retained in the private audit log.

## Closing a thread

Close immediately, or give a duration and an optional reason:

```text
.close
.close now Resolved
.close 2h Waiting for a final response
.cancelclose
```

Durations such as `30m`, `2h`, and `1d` are supported, from one second to 30 days. **Replies do not cancel a scheduled close.** Use `.cancelclose` if you want to keep the thread open.

On closure, the bot saves the transcript and attachments, uploads the archive to your log channel, and then deletes the staff channel. If the upload fails, it keeps the channel and retries.

## Finding logs

Use `.logs` in a thread to see that member’s history. Elsewhere in the private log channel, supply their ID. Search text follows the page number:

```text
.logs
.logs 123456789012345678
.logs 123456789012345678 1 appeal
.log 42
```

`.log 42` downloads the archive for closed thread 42. Inside an open thread, `.loglink` creates a snapshot, or returns a live link when the [private log viewer](oauth.html) is enabled.

## Canned replies

Staff with level 3 access can save common replies as snippets. Any staff member can send a saved snippet:

```text
.snippet set received Thanks for contacting us. We’ve received your report.
.snippet received
.snippets
```

Snippets are sent anonymously. Use `.snippet delete received` to remove one. [Aliases](configuration.html#availability-and-first-message-rules) let you make shortcuts to commands with preset arguments.

## Notifications and snoozing

Run `.notify` to get a ping for the next member message, or `.subscribe` for every member message. You can pass a staff user or role mention instead of notifying yourself.

```text
.notify
.subscribe
.unsubscribe
.snooze 2h
.unsnooze
```

With the default snooze mode, incoming messages are saved until the thread resumes. In `wake` mode, a new DM wakes it immediately. [Configuration](configuration.html#notifications-and-snoozing) covers notification targets and snooze settings.

## Adding another member

`.adduser` adds someone to an existing conversation. They receive a notice that future messages are shared with the other participants. Older messages are not replayed to them.

```text
.adduser 123456789012345678
.removeuser 123456789012345678
```

The anonymous variants, `.anonadduser` and `.anonremoveuser`, leave your moderator name out of the notice. A thread can have up to ten members, and a member can be in only one active thread at a time.

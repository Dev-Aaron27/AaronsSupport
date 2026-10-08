# Log viewer

The log viewer lets staff read transcripts in their browser after signing in with Discord. It is optional. Without it, `.loglink` posts a snapshot archive into the private Discord log channel and returns its message link. `.log` reuploads a closed archive from disk.

With the viewer enabled, `.loglink` returns an authenticated live transcript URL. It runs on your bot host and is separate from the public GitHub Pages documentation. Never put transcripts, attachments, environment files, or the data directory in the Pages artifact.

## Configure Discord OAuth

In your application's OAuth2 settings, register exactly:

```text
https://logs.example.com/callback
```

Set these environment variables on the bot host:

```text
LOG_VIEWER_URL=https://logs.example.com
LOG_VIEWER_HOST=0.0.0.0
LOG_VIEWER_PORT=8787
DISCORD_CLIENT_ID=your_application_id
DISCORD_CLIENT_SECRET=your_private_oauth_client_secret
```

Serve the application through your existing HTTPS reverse proxy. The public URL must be an HTTPS origin with no path, query, or credentials. HTTP is permitted only for localhost development.

For Docker, use the optional overlay:

```sh
docker compose -f compose.yaml -f compose.viewer.yaml up -d --build
```

The overlay publishes port 8787 only on host loopback; configure the host HTTPS proxy to forward to it. Direct Node deployment defaults to listening on 127.0.0.1. `/health` returns only readiness, with no private data.

## Authentication behavior

The login flow uses Discord's `identify` scope, an unpredictable state bound to an HttpOnly browser cookie, and an expiring session. The bot checks the logged-in user's **current** server membership and staff permissions on every transcript and file request. Removed staff lose access on the next request. Discord access tokens are used to resolve identity during login and are not saved in the session database.

Sessions live in memory, expire after one hour, and disappear on restart. Cookies use SameSite=Lax and Secure on HTTPS. Responses disable caching and prevent framing. Attachments are downloaded with an attachment disposition and must belong to the requested ticket. Logout checks the request origin.

`.oauth` shows status and the login URL. `.oauth logoutall` invalidates every viewer session and pending login. Only level 5 can run these commands.

This viewer is for staff. Members cannot access transcripts. Logs include real moderator identities, internal notes, and retained deleted content. HTML is escaped and generated without script execution.

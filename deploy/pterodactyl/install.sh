#!/bin/bash
set -euo pipefail
umask 022

# Wings mounts the persistent server volume here during installation.
server_dir=/mnt/server
mkdir -p "$server_dir"
cd "$server_dir"

# Abort rather than replace a folder owned by another application.
if [ -L app ] || { [ -e app ] && { [ ! -d app ] || [ ! -f app/.aarons-support-managed ]; }; }; then
  echo "Installation stopped: app/ already exists without the Aarons Support ownership marker." >&2
  exit 1
fi
for persistent in data plugins; do
  if [ -L "$persistent" ] || { [ -e "$persistent" ] && [ ! -d "$persistent" ]; }; then
    echo "Installation stopped: $persistent must be a regular directory." >&2
    exit 1
  fi
done

staging=$(mktemp -d "$server_dir/.aarons-install.XXXXXX")
previous=''
cleanup() {
  if [ -n "$previous" ] && [ -d "$previous/app" ] && [ ! -e "$server_dir/app" ]; then
    mv "$previous/app" "$server_dir/app"
  fi
  rm -rf "$staging"
  if [ -n "$previous" ]; then rm -rf "$previous"; fi
}
trap cleanup EXIT

base64 --decode > "$staging/application.tar.gz" <<'AARONS_SUPPORT_BUNDLE'
@@BUNDLE_BASE64@@
AARONS_SUPPORT_BUNDLE
printf '%s  %s\n' '@@BUNDLE_SHA256@@' "$staging/application.tar.gz" | sha256sum --check --status
mkdir "$staging/app"
tar -xzf "$staging/application.tar.gz" -C "$staging/app" --no-same-owner --no-same-permissions

node -e 'if (Number(process.versions.node.split(".")[0]) < 24) throw new Error("Node.js 24 or newer is required")'
# Install before replacing a working copy. Lockfile enforces exact dependency versions.
(cd "$staging/app" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund)
touch "$staging/app/.aarons-support-managed"

mkdir -p "$server_dir/data" "$server_dir/plugins"
# Existing custom plugins and edits to the example plugin are retained.
if [ ! -e "$server_dir/plugins/example" ] && [ ! -L "$server_dir/plugins/example" ]; then
  cp -R "$staging/app/plugins/example" "$server_dir/plugins/example"
  chown -R --reference="$server_dir" "$server_dir/plugins/example"
fi

chown -R --reference="$server_dir" "$staging/app"
chown --reference="$server_dir" "$server_dir/data" "$server_dir/plugins"

if [ -d "$server_dir/app" ]; then
  previous=$(mktemp -d "$server_dir/.aarons-previous.XXXXXX")
  mv "$server_dir/app" "$previous/app"
fi
mv "$staging/app" "$server_dir/app"
echo 'Installation complete. Fill in the bot token, guild ID, and staff role IDs in Startup, then start the server.'
echo 'Existing config.json, data/, plugins/, and .env files were preserved.'

# Contributing

Thanks for helping improve Aaron’s Support. Open an issue to report a bug or discuss a change, or submit a pull request with a focused fix.

## Local development

Use Node.js 24 or newer. Install the locked dependencies:

```sh
npm ci
```

Copy `.env.example` to `.env` and `config.example.json` to `config.json` if you need to run the bot. Use a separate Discord application and server for development. See the [installation guide](docs/setup.md) for the required permissions.

Keep bot tokens, OAuth secrets, databases, and conversation attachments out of commits and issue reports. Use synthetic identities and messages in fixtures.

## Automated checks

Run the checks relevant to your change before submitting it:

```sh
npm run check
npm test
npm audit --omit=dev
npm run docs:build
```

The tests live in `test/` and use temporary databases and simulated Discord/OAuth responses. Changes to Gateway delivery, permission overwrites, or OAuth setup also need a check against a development Discord server.

For container changes, build the image:

```sh
docker build -t aarons-support:dev .
```

CI runs the source checks, tests, dependency audit, documentation build, egg consistency check, and Docker build.

## Documentation

Guides live in `docs/`. Keep Markdown links relative to the source files so they work when browsing the repository. The website builder converts links between guides to HTML and maps the egg download to the site’s downloads directory.

Command documentation is generated from `src/catalog.js`. Update that catalog when changing a command’s usage, description, or permission level.

```sh
npm run docs:build
python3 -m http.server 4173 --directory _site --bind 0.0.0.0
```

The generated `_site/` directory is ignored by Git. Public guides should explain installation and use; development instructions belong here.

## GitHub Pages

In repository **Settings → Pages**, choose **GitHub Actions** as the source. The Documentation workflow publishes the site on changes to `main`, or through **Actions → Documentation → Run workflow**.

The default site address is `https://dev-aaron27.github.io/AaronsSupport/`. GitHub’s deployment job reports the URL after publishing. Pages hosts documentation; the OAuth log viewer runs on the bot host.

## Pterodactyl egg

The egg includes a source bundle and installs the locked dependencies. Rebuild it whenever changing bundled application code, package manifests, example configuration, installer, or egg template:

```sh
npm run pterodactyl:build
```

Packaging requires Node.js 24 and GNU tar. Commit `deploy/pterodactyl/egg-aarons-support.json` and `deploy/pterodactyl/SHA256SUMS` together with the source change. The separate generated application archive is ignored by Git.

The runtime bundle uses an explicit file allowlist and omits documentation. The builder rejects installation scripts larger than 65,535 bytes, the limit of Pterodactyl’s database column. `egg-template.json` is a build input; import only `egg-aarons-support.json`. It excludes live configuration, environment files, conversation data, installed dependencies, and custom plugins. CI regenerates the egg and rejects a mismatch.

Run `npm run pterodactyl:build` before `npm run docs:build` when checking the downloadable egg on the docs site.

## Pull requests

Describe the behavior changed, the reason, and the checks you ran. Add regression coverage for fixes to delivery, persistence, authorization, or OAuth. Keep unrelated changes separate, and update the relevant user guide when a command or configuration option changes.

Plugins are trusted local JavaScript. Document new plugin hooks and API changes in the [plugin guide](docs/plugins.md), and keep the example plugin working.

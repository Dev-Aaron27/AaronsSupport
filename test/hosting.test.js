import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
import { panelOverrides, preparePterodactyl } from '../src/hosting.js';
import { readConfig, validateConfig } from '../src/config.js';

const template = resolve('config.example.json');
const panel = () => ({
  MODMAIL_GUILD_ID: '100000000000000001', MODMAIL_STAFF_ROLE_IDS: '100000000000000002, 100000000000000003',
  DISCORD_TOKEN: 'synthetic-token-for-tests', DISCORD_CLIENT_SECRET: 'synthetic-secret-for-tests',
});
async function temporary(t) {
  const dir = await mkdtemp(join(tmpdir(), 'modmail-hosting-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('panel startup creates a valid persistent config and never writes secrets', async t => {
  const root = await temporary(t), env = panel();
  const result = await preparePterodactyl(root, template, env);
  const text = await readFile(result.configPath, 'utf8'), config = JSON.parse(text);
  assert.equal(config.guildId, env.MODMAIL_GUILD_ID);
  assert.deepEqual(config.staffRoleIds, ['100000000000000002', '100000000000000003']);
  assert.equal(config.prefix, '.'); assert.equal(config.categoryId, null);
  assert.ok(!text.includes(env.DISCORD_TOKEN)); assert.ok(!text.includes(env.DISCORD_CLIENT_SECRET));
  assert.equal(env.DATA_DIR, join(root, 'data')); assert.equal(env.PLUGIN_DIR, join(root, 'plugins'));
  await access(env.DATA_DIR); await access(env.PLUGIN_DIR);
  const custom = { ...config, status: 'Custom activity', snippets: { saved: 'Saved reply' } };
  await writeFile(result.configPath, JSON.stringify(custom));
  await writeFile(join(env.DATA_DIR, 'keep.txt'), 'conversation data');
  env.MODMAIL_GUILD_ID = '100000000000000004';
  await preparePterodactyl(root, template, env);
  assert.deepEqual(JSON.parse(await readFile(result.configPath, 'utf8')), custom);
  assert.equal(await readFile(join(env.DATA_DIR, 'keep.txt'), 'utf8'), 'conversation data');
  const effective = validateConfig({ ...readConfig(result.configPath, panelOverrides(env)), ...{ prefix: '?', categoryId: '100000000000000006' }, ...panelOverrides(env) });
  assert.equal(effective.guildId, env.MODMAIL_GUILD_ID); assert.equal(effective.prefix, '?'); assert.equal(effective.categoryId, '100000000000000006');
  env.MODMAIL_PREFIX = '.'; assert.equal(validateConfig({ ...effective, ...panelOverrides(env) }).prefix, '.');
});

test('ordinary deployment ignores panel variables; optional empty lists and initial templates work', async t => {
  assert.deepEqual(panelOverrides(panel()), {});
  const root = await temporary(t), env = { ...panel(), MODMAIL_ADMIN_ROLE_IDS: 'none', MODMAIL_OWNER_USER_IDS: '100000000000000007' };
  await writeFile(join(root, 'config.json'), await readFile(template));
  const before = await readFile(join(root, 'config.json'), 'utf8');
  await preparePterodactyl(root, template, env);
  const config = readConfig(join(root, 'config.json'), panelOverrides(env));
  assert.deepEqual(config.adminRoleIds, []); assert.deepEqual(config.ownerUserIds, ['100000000000000007']);
  assert.equal(await readFile(join(root, 'config.json'), 'utf8'), before);
});

test('invalid saved configuration is preserved and invalid panel values fail without echoing secrets', async t => {
  const root = await temporary(t), env = panel();
  await writeFile(join(root, 'config.json'), '{ broken json');
  await assert.rejects(preparePterodactyl(root, template, env), /not valid JSON/);
  assert.equal(await readFile(join(root, 'config.json'), 'utf8'), '{ broken json');
  await rm(join(root, 'config.json'));
  env.MODMAIL_STAFF_ROLE_IDS = 'everyone';
  await assert.rejects(preparePterodactyl(root, template, env), /staffRoleIds/);
  await assert.rejects(access(join(root, 'config.json')));
});

test('optional viewer uses the primary allocation and requires both OAuth variables', async t => {
  const root = await temporary(t), env = { ...panel(), LOG_VIEWER_URL: 'https://logs.example.com', SERVER_PORT: '29001' };
  await assert.rejects(preparePterodactyl(root, template, env), /both OAuth/);
  env.DISCORD_CLIENT_ID = '100000000000000009';
  env.SERVER_PORT = 'invalid'; await assert.rejects(preparePterodactyl(root, template, env), /SERVER_PORT/);
  env.SERVER_PORT = '29001'; await preparePterodactyl(root, template, env);
  assert.equal(env.LOG_VIEWER_HOST, '0.0.0.0'); assert.equal(env.LOG_VIEWER_PORT, '29001');
  env.LOG_VIEWER_URL = ' '; await preparePterodactyl(root, template, env); assert.equal(env.LOG_VIEWER_URL, undefined);
});

test('self-contained egg matches its source, preserves PTDL_v2 contract and excludes private files', async t => {
  const root = await temporary(t);
  execFileSync(process.execPath, ['scripts/build-pterodactyl.js', root]);
  const raw = await readFile(join(root, 'egg-aarons-support.json'), 'utf8');
  assert.equal(raw, await readFile('deploy/pterodactyl/egg-aarons-support.json', 'utf8'), 'Rebuild the committed egg after editing bundled sources.');
  const egg = JSON.parse(raw);
  assert.equal(egg.meta.version, 'PTDL_v2'); assert.equal(egg.config.stop, '^C');
  assert.equal(egg.startup, 'exec node app/scripts/pterodactyl-start.js');
  assert.ok(!egg.startup.includes('{{')); assert.ok(!egg.startup.includes('DISCORD_TOKEN'));
  assert.equal(JSON.parse(egg.config.startup).done, 'Ready: moderator inbox for server');
  assert.deepEqual(JSON.parse(egg.config.files), {});
  assert.ok(Object.values(egg.docker_images).every(image => image.endsWith(':nodejs_24')));
  const names = egg.variables.map(v => v.env_variable);
  assert.equal(new Set(names).size, names.length);
  for (const key of ['DISCORD_TOKEN', 'MODMAIL_GUILD_ID', 'MODMAIL_STAFF_ROLE_IDS']) assert.ok(egg.variables.find(v => v.env_variable === key).rules.startsWith('required|'));
  for (const key of ['DISCORD_TOKEN', 'DISCORD_CLIENT_SECRET']) assert.equal(egg.variables.find(v => v.env_variable === key).default_value, '');
  const script = egg.scripts.installation.script;
  assert.equal(spawnSync('bash', ['-n'], { input: script }).status, 0);
  const embedded = script.split("<<'AARONS_SUPPORT_BUNDLE'\n")[1].split('\nAARONS_SUPPORT_BUNDLE')[0];
  const bytes = Buffer.from(embedded, 'base64'), hash = createHash('sha256').update(bytes).digest('hex');
  assert.ok(script.includes(hash)); assert.deepEqual(bytes, await readFile(join(root, 'aarons-support.tar.gz')));
  const entries = execFileSync('tar', ['-tf', '-'], { input: gunzipSync(bytes), encoding: 'utf8' }).trim().split('\n');
  assert.ok(entries.includes('./src/main.js')); assert.ok(entries.includes('./scripts/pterodactyl-start.js'));
  assert.ok(entries.includes('./pterodactyl-release.json'));
  assert.ok(!entries.some(path => /(^|\/)(\.env|config\.json|data|node_modules|\.git)(\/|$)/.test(path)));
  assert.ok(!entries.some(path => path.startsWith('/') || path.split('/').includes('..')));
});

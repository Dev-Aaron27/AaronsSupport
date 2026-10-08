import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Collection, PermissionFlagsBits as P, PermissionsBitField, ChannelType, Events } from 'discord.js';
import { DiscordTransport, installHandlers } from '../src/bot.js';
import { validateConfig } from '../src/config.js';

const config = validateConfig({ guildId: '100000000000000001', categoryId: '100000000000000002', logChannelId: '100000000000000003', staffRoleIds: ['100000000000000004'] });
const permissions = (...bits) => new PermissionsBitField(bits);

test('ticket overwrites hide @everyone, allow configured staff and bot, never grant Administrator', () => {
  const transport = new DiscordTransport({ user: { id: 'bot' } }, config);
  const overwrites = transport.overwrites({ id: config.guildId });
  assert.deepEqual(overwrites[0], { id: config.guildId, deny: [P.ViewChannel] });
  assert.ok(overwrites.find(o => o.id === config.staffRoleIds[0]).allow.includes(P.ViewChannel));
  assert.ok(overwrites.every(o => !o.allow?.includes(P.Administrator)));
  assert.ok(overwrites.find(o => o.id === 'bot').allow.includes(P.ManageRoles));
});

test('privacy gate rejects roles and member overrides that expose a staff channel', async () => {
  const publicRole = { id: config.guildId, permissions: permissions() };
  const adminRole = { id: 'admin', permissions: permissions(P.Administrator) };
  const staffRole = { id: config.staffRoleIds[0], permissions: permissions() };
  const roles = new Collection([[publicRole.id, publicRole], [adminRole.id, adminRole], [staffRole.id, staffRole]]);
  const guild = { id: config.guildId, members: {}, roles: { cache: roles, fetch: async () => {} } };
  const transport = new DiscordTransport({ user: { id: 'bot' } }, config);
  transport.guild = async () => guild;
  let publicVisible = false;
  const channel = { guildId: config.guildId, id: 'channel', permissionsFor: role => permissions(...(role.id !== publicRole.id || publicVisible ? [P.ViewChannel] : [])), permissionOverwrites: { cache: new Collection() } };
  await transport.assertPrivate(channel);
  publicVisible = true;
  await assert.rejects(transport.assertPrivate(channel), /non-staff role/);
  publicVisible = false;
  channel.permissionOverwrites.cache.set('outsider', { id: 'outsider', type: 1, allow: permissions(P.ViewChannel) });
  transport.member = async () => ({ permissions: permissions(), roles: { cache: new Collection() } });
  await assert.rejects(transport.assertPrivate(channel), /non-staff member/);
});

test('outbound messages hide staff identity and disable mentions', async () => {
  let sent;
  const dm = { send: async payload => { sent = payload; } };
  const transport = new DiscordTransport({ users: { fetch: async () => ({ createDM: async () => dm }) } }, config);
  await transport.send({ user_id: 'member' }, { direction: 'staff', content: '@everyone hello', author_name: 'Private moderator name', options: { anonymous: true, plain: false } }, []);
  assert.ok(JSON.stringify(sent.components).includes('Moderation team'));
  assert.equal(sent.flags, 32768);
  assert.equal(sent.content, undefined);
  assert.equal(sent.embeds, undefined);
  assert.ok(JSON.stringify(sent.components).includes('[REMOVED_PING] hello'));
  assert.ok(!JSON.stringify(sent).includes('Private moderator name'));
  assert.deepEqual(sent.allowedMentions.parse, []);
});

test('gateway handlers serialize immediate edit/delete behind the original DM and drain on shutdown', async () => {
  const client = new EventEmitter();
  const rows = new Map();
  const calls = [];
  const inbox = {
    config,
    receive: async message => { await new Promise(resolve => setTimeout(resolve, 10)); rows.set(message.id, { direction: 'member' }); calls.push('create'); },
    edit: async () => { calls.push('edit'); },
    delete: async () => { calls.push('delete'); },
  };
  const transport = { report: error => { throw error; } };
  const store = { message: id => rows.get(id) };
  const handlers = installHandlers(client, inbox, transport, store);
  handlers.start();
  const message = { id: '1', channelId: 'dm', channel: { type: ChannelType.DM }, author: { bot: false }, content: 'hi' };
  client.emit(Events.MessageCreate, message);
  client.emit(Events.MessageUpdate, message, { ...message, content: 'edited' });
  client.emit(Events.MessageDelete, message);
  await handlers.stop();
  assert.deepEqual(calls, ['create', 'edit', 'delete']);
});

test('ordinary staff chat stays local and explicit reply commands require current roles', async () => {
  const client = new EventEmitter();
  let allowed = false;
  let replies = 0;
  const notices = [];
  const inbox = { config, reply: async () => { replies++; } };
  const transport = {
    member: async () => ({}), level: () => allowed ? 2 : 1,
    assertPrivate: async () => {}, report: () => {},
  };
  const store = { byChannel: id => id === 'staff' ? { id: 1 } : null };
  const handlers = installHandlers(client, inbox, transport, store);
  const message = { id: '1', guildId: config.guildId, channelId: 'staff', content: 'hello', author: { id: 'user', bot: false }, channel: { send: async payload => { notices.push(JSON.stringify(payload.components)); } }, react: async () => {} };
  handlers.start();
  client.emit(Events.MessageCreate, message);
  await handlers.stop();
  assert.equal(replies, 0);
  allowed = true;
  handlers.start();
  client.emit(Events.MessageCreate, { ...message, channelId: 'public' });
  client.emit(Events.MessageCreate, { ...message, content: '.config prefix "?"' });
  client.emit(Events.MessageCreate, message);
  client.emit(Events.MessageCreate, { ...message, content: '.ar hello' });
  client.emit(Events.MessageCreate, { ...message, content: '.r hello' });
  await handlers.stop();
  assert.equal(replies, 2);
  assert.ok(notices.some(text => text.includes('requires permission level 4')));
});

test('long closure reasons remain valid V2 summaries while archive uploads complete',async()=>{
  const sent=[];let edit;
  const channel={send:async payload=>{sent.push(payload);return {url:'https://discord.com/channels/g/l/m',edit:async payload=>{edit=payload;}};}};
  const transport=new DiscordTransport({},config);transport.channel=async()=>channel;transport.assertPrivate=async()=>{};
  const archives={async *parts(){yield {attachment:Buffer.from('zip'),name:'archive.zip'};}};
  const url=await transport.publishArchive({id:1,user_id:'member',closed_by:'mod',close_reason:'@everyone '.repeat(700)},'/ignored',archives);
  assert.ok(url.endsWith('/m'));assert.ok(JSON.stringify(edit).includes('Archive upload complete'));assert.ok(JSON.stringify(edit).includes('[REMOVED_PING]'));assert.equal(sent.length,2);
});


test('ticket opener is a private V2 card with account information and explicit reply instructions',async()=>{
  const category={id:config.categoryId},sent=[];
  const channel={id:'staff',send:async payload=>{sent.push(payload);return {};}};
  const guild={channels:{fetch:async id=>id?category:new Collection(),create:async()=>channel}};
  const transport=new DiscordTransport({user:{id:'bot'}},config);transport.guild=async()=>guild;transport.assertPrivate=async()=>{};transport.member=async()=>({joinedTimestamp:1700000000000});
  await transport.open({id:42,user_id:'member'},{id:'member',username:'Example @everyone',createdTimestamp:1600000000000});
  const payload=sent[0],text=JSON.stringify(payload.components);
  assert.equal(payload.flags,32768);assert.equal(payload.components[0].type,17);assert.match(text,/Account created/);assert.match(text,/Joined server/);assert.match(text,/Only reply commands/);assert.match(text,/\[REMOVED_PING\]/);assert.ok(!text.includes('Ordinary staff messages are anonymous replies'));
});

test('member acknowledgement reacts on the original DM with a checkmark',async()=>{
  let channelId,messageId,reaction;
  const transport=new DiscordTransport({},config);transport.channel=async id=>{channelId=id;return {messages:{fetch:async id=>{messageId=id;return {react:async emoji=>{reaction=emoji;}};}}};};
  await transport.acknowledge({source_channel:'dm',source_id:'message'});assert.equal(channelId,'dm');assert.equal(messageId,'message');assert.equal(reaction,'✅');
});


test('management commands work in other private staff channels and explain denied locations and permissions',async()=>{
  const cfg=validateConfig({...config}),client=new EventEmitter(),responses=[],logs=[],settings=[];
  let level=3,privateChannel=true;
  const transport={member:async()=>({}),level:()=>level,assertPrivate:async()=>{if(!privateChannel)throw new Error('Public channel');},info:(scope,text)=>logs.push(text),report:()=>{}};
  const store={byChannel:()=>null,setSetting:(key,value)=>settings.push([key,value])};
  const inbox={config:cfg},handlers=installHandlers(client,inbox,transport,store);
  const message={id:'1',guildId:cfg.guildId,channelId:'staff-commands',content:'.alias add thanks areply PRIVATE_ARGUMENT && close 1h',author:{id:'staff',bot:false},channel:{send:async payload=>{responses.push(JSON.stringify(payload));return {};}}};
  const send=async overrides=>{handlers.start();client.emit(Events.MessageCreate,{...message,...overrides});await handlers.stop();};
  await send();assert.equal(settings[0][0],'aliases');assert.match(responses.at(-1),/aliases updated/);assert.ok(logs.some(text=>text.includes('Completed alias')));assert.ok(!logs.join('').includes('PRIVATE_ARGUMENT'));
  privateChannel=false;const count=settings.length;await send({content:'.alias add no areply hello'});assert.equal(settings.length,count);assert.match(responses.at(-1),/private staff channel/);
  level=2;privateChannel=true;await send();assert.match(responses.at(-1),/requires permission level 3/);
  await send({content:'.reply hello'});assert.match(responses.at(-1),/active inbox channel/);
  await send({content:'.nonesuch'});assert.match(responses.at(-1),/Unknown command/);
  await send({guildId:'different-server'});assert.match(responses.at(-1),/configured for another server/);
});

test('public alias steps cannot bypass privacy for later management commands',async()=>{
  const cfg=validateConfig({...config,aliases:{leak:'help && config',bootstrap:'setup && config'}}),client=new EventEmitter(),responses=[];
  let setups=0;
  const transport={member:async()=>({}),level:()=>5,assertPrivate:async()=>{throw new Error('Public channel');},setup:async()=>{setups++;},report:()=>{}};
  const handlers=installHandlers(client,{config:cfg},transport,{byChannel:()=>null});
  for(const name of ['leak','bootstrap']) {
    handlers.start();client.emit(Events.MessageCreate,{id:'1',guildId:cfg.guildId,channelId:'public',content:'.'+name,author:{id:'owner',bot:false},channel:{send:async payload=>{responses.push(JSON.stringify(payload));return {};}}});await handlers.stop();
    assert.match(responses.at(-1),/private staff channel/);assert.ok(!responses.at(-1).includes('Editable runtime keys'));
  }
  assert.equal(setups,0);
});

test('command response failures produce actionable console diagnostics instead of disappearing',async()=>{
  const client=new EventEmitter(),errors=[];
  const transport={member:async()=>({}),level:()=>1,report:(error,context)=>errors.push([error.code,context])};
  const handlers=installHandlers(client,{config},transport,{byChannel:()=>null});
  handlers.start();client.emit(Events.MessageCreate,{id:'1',guildId:config.guildId,channelId:'public',content:'.config',author:{id:'member',bot:false},channel:{send:async()=>{throw Object.assign(new Error('raw sensitive request'),{code:50013});}}});await handlers.stop();
  assert.ok(errors.some(([code,context])=>code===50013 && context.includes('could not send the error response')));
});

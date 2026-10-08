import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm,mkdir,writeFile,symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PermissionsBitField,PermissionFlagsBits as P,Collection } from 'discord.js';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/store.js';
import { validateConfig,parseCommand } from '../src/config.js';
import { levelFor,authorize } from '../src/permissions.js';
import { panel,stripPings,formatVariables } from '../src/ui.js';
import { replyOptions } from '../src/catalog.js';
import { Plugins } from '../src/plugins.js';
import { CommandRouter } from '../src/commands.js';
const ids={guildId:'100000000000000001',categoryId:'100000000000000002',logChannelId:'100000000000000003',staffRoleIds:['100000000000000004']};
const config=()=>validateConfig(ids);
async function temp(t){const dir=await mkdtemp(join(tmpdir(),'advanced-'));t.after(()=>rm(dir,{recursive:true,force:true}));return dir;}

test('Components V2 supports anonymous/named/plain variants, attachment components and explicit notification allowlists',()=>{
  assert.equal(config().prefix,'.');
  for(const name of ['reply','areply','freply','fareply'])assert.equal(replyOptions(name,config()).plain,false);
  for(const name of ['preply','pareply','fpreply','fpareply'])assert.equal(replyOptions(name,config()).plain,true);
  const payload=panel('@everyone 67 <@!123> <@&456> @here @name',{title:'@mod',files:[{attachment:Buffer.from('a'),name:'@everyone.png'},{attachment:Buffer.from('b'),name:'file.txt'}]});
  assert.equal(payload.flags,32768);assert.equal(payload.embeds,undefined);assert.equal(payload.content,undefined);
  assert.ok(JSON.stringify(payload.components).includes('[REMOVED_PING] 67'));
  assert.equal(payload.components[0].components.filter(c=>c.type===12).length,1);
  assert.equal(payload.components[0].components.filter(c=>c.type===13).length,1);
  assert.deepEqual(payload.allowedMentions.parse,[]);
  const notification=panel('Message from @someone',{mentions:[{kind:'role',id:ids.staffRoleIds[0]}]});
  assert.deepEqual(notification.allowedMentions.roles,[ids.staffRoleIds[0]]);
  assert.equal(stripPings('hello @everyone 67'),'hello [REMOVED_PING] 67');
  assert.equal(formatVariables('{user.id} {ticket.id} {unknown}',{ticket:{id:4,user_id:'123'}}),'123 4 {unknown}');
});

test('permission levels enforce roles, owner actions, and raised command requirements including aliases',()=>{
  const cfg=config();cfg.permissionRoles={'100000000000000006':3};cfg.ownerUserIds=['100000000000000007'];
  const member=(id,roles=[],admin=false)=>({id,permissions:new PermissionsBitField(admin?[P.Administrator]:[]),roles:{cache:new Collection(roles.map(r=>[r,{}]))}});
  assert.equal(levelFor(member('member'),cfg,'guildOwner'),1);
  assert.equal(levelFor(member('mod',cfg.staffRoleIds),cfg,'guildOwner'),2);
  assert.equal(levelFor(member('senior',['100000000000000006']),cfg,'guildOwner'),3);
  assert.equal(levelFor(member('admin',[],true),cfg,'guildOwner'),4);
  assert.equal(levelFor(member('100000000000000007'),cfg,'guildOwner'),5);
  assert.throws(()=>authorize('plugins',4,cfg),/level 5/);
  cfg.commandLevels={close:4};assert.throws(()=>authorize('close',2,cfg),/level 4/);
  cfg.aliases={shutdown:'close now Done'};const cmd=parseCommand('.shutdown',cfg);assert.equal(cmd.name,'close');assert.equal(cmd.args,'now Done');assert.throws(()=>authorize(cmd.name,2,cfg));
  assert.throws(()=>validateConfig({...cfg,commandLevels:{plugins:2}}),/only raise/);
});

test('version 1 database migrates messages, copies, history and participant uniqueness without losing content',async t=>{
  const dir=await temp(t),db=new DatabaseSync(join(dir,'inbox.sqlite'));
  db.exec(`CREATE TABLE tickets(id INTEGER PRIMARY KEY,user_id TEXT NOT NULL,channel_id TEXT UNIQUE,status TEXT NOT NULL DEFAULT 'opening',created_at INTEGER NOT NULL,closed_at INTEGER,close_at INTEGER,close_reason TEXT,closed_by TEXT,log_url TEXT,archive_path TEXT,last_error TEXT);
    CREATE TABLE messages(id INTEGER PRIMARY KEY,ticket_id INTEGER NOT NULL,source_id TEXT UNIQUE NOT NULL,source_channel TEXT NOT NULL,target_id TEXT,target_channel TEXT,direction TEXT NOT NULL,author_id TEXT NOT NULL,author_name TEXT NOT NULL,content TEXT NOT NULL,attachments TEXT NOT NULL DEFAULT '[]',created_at INTEGER NOT NULL,edited_at INTEGER,deleted_at INTEGER,delivery TEXT NOT NULL DEFAULT 'pending');
    INSERT INTO tickets(id,user_id,channel_id,status,created_at) VALUES(1,'user','staff','open',1);
    INSERT INTO messages(id,ticket_id,source_id,source_channel,target_id,target_channel,direction,author_id,author_name,content,created_at) VALUES(1,1,'source','dm','copy','staff','member','user','User','original',1);`);db.close();
  const store=new Store(dir);t.after(()=>store.close());assert.equal(store.active('user').id,1);assert.equal(store.message('source').content,'original');assert.equal(store.copies(1)[0].target_id,'copy');
  store.addParticipant(1,'second');assert.throws(()=>store.createTicket('second'));assert.equal(store.live().length,1);
});

test('plugin lifecycle registers commands, persists isolated data, rejects traversal and cleans failed loads',async t=>{
  const dir=await temp(t),store=new Store(dir);t.after(()=>store.close());const root=join(dir,'plugins');await mkdir(join(root,'sample'),{recursive:true});
  await writeFile(join(root,'sample','index.js'),`export default {apiVersion:1,name:'sample',start(api){api.registerCommand('samplecmd',{level:3,description:'Example',execute:async c=>c.respond('ok')});},hooks:{threadOpen(_event,api){api.set('count',(api.get('count')||0)+1);}}};`);
  const manager=new Plugins(root,store,{config:config(),report:()=>{}});await manager.load('sample');assert.equal(manager.command('samplecmd').level,3);await manager.emit('threadOpen',{ticket:{id:1}});assert.equal(store.pluginGet('sample','count'),1);
  await manager.unload('sample');assert.equal(manager.command('samplecmd'),undefined);
  await assert.rejects(manager.load('../sample'),/Invalid/);
  await mkdir(join(root,'bad'));await writeFile(join(root,'bad','index.js'),`export default {apiVersion:1,name:'bad',start(api){api.registerCommand('half',{level:2,description:'x',execute(){}});throw new Error('failed');}}`);
  await assert.rejects(manager.load('bad'),/failed/);assert.equal(manager.command('half'),undefined);
  await writeFile(join(dir,'outside.js'),'export default {}');await mkdir(join(root,'escape'));await symlink(join(dir,'outside.js'),join(root,'escape','index.js'));await assert.rejects(manager.load('escape'),/inside/);
});

test('clearsnoozed requires actor-bound confirmation and rechecks owner permission',async t=>{
  const dir=await temp(t),store=new Store(dir);t.after(()=>store.close());const ticket=store.createTicket('member');store.updateTicket(ticket.id,{status:'open',snoozed_at:1});
  let resumed=0,last;
  const inbox={config:config(),unsnooze:async()=>{resumed++;}},router=new CommandRouter(inbox,{},store);
  const ctx={message:{author:{id:'owner'},channelId:'log'},level:5,respond:async(text,options)=>{last={text,options};}};
  await router.execute(ctx,'clearsnoozed');assert.equal(resumed,0);
  const token=last.options.controls[0].custom_id.split(':')[1];
  await assert.rejects(router.confirm({...ctx,message:{author:{id:'someone'},channelId:'log'}},token),/belongs/);
  await assert.rejects(router.confirm({...ctx,level:2},token),/level 5/);
  await router.confirm(ctx,token);assert.equal(resumed,1);await assert.rejects(router.confirm(ctx,token),/expired/);
});

test('long mention-heavy notices are sanitized before splitting into valid V2 cards',async()=>{
  const {sendPanels}=await import('../src/ui.js');const sent=[];await sendPanels({send:async payload=>{sent.push(payload);return {id:'id'};}},'@everyone '.repeat(700));
  assert.ok(sent.length>1);const texts=sent.map(p=>p.components[0].components[0].content);
  assert.equal(texts.join(''),'[REMOVED_PING] '.repeat(700));assert.ok(texts.every(text=>text.length<=3600));
});

test('closure state and participant release are atomic',async t=>{
  const dir=await temp(t),store=new Store(dir);t.after(()=>store.close());const ticket=store.createTicket('member');store.updateTicket(ticket.id,{status:'closing'});
  const release=store.releaseParticipants.bind(store);store.releaseParticipants=()=>{throw new Error('simulated failure');};assert.throws(()=>store.finishTicket(ticket.id),/simulated/);
  assert.equal(store.ticket(ticket.id).status,'closing');assert.equal(store.participants(ticket.id).length,1);
  store.releaseParticipants=release;store.finishTicket(ticket.id);assert.equal(store.ticket(ticket.id).status,'closed');assert.equal(store.participants(ticket.id).length,0);assert.ok(store.createTicket('member'));
});

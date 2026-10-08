import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createLogger, safeError } from '../src/logging.js';

async function temp(t) { const root=await mkdtemp(join(tmpdir(),'modmail-logging-'));t.after(()=>rm(root,{recursive:true,force:true}));return root; }
test('console lines are purple, file logs are plain, control characters are removed and rotation is bounded',async t=>{
  const root=await temp(t),lines=[];
  const logger=createLogger({color:true,write:line=>lines.push(line),now:()=>new Date('2026-10-08T22:20:34Z'),maxBytes:200});
  logger.setDirectory(root);logger.info('startup','Prefix: .\nInjected\x1b[31m');
  assert.match(lines[0],/^\x1b\[35m2026-10-08 22:20:34 UTC startup - INFO:/);assert.ok(lines[0].endsWith('\x1b[0m'));assert.ok(!lines[0].includes('\n'));assert.ok(!lines[0].includes('\x1b[31m'));
  const file=await readFile(logger.file,'utf8');assert.ok(!file.includes('\x1b'));assert.match(file,/Prefix: ./);assert.equal((await stat(logger.file)).mode&0o777,0o600);
  for(let i=0;i<30;i++)logger.info('startup','Log entry '+i);
  assert.deepEqual((await readdir(join(root,'logs'))).sort(),['modmail.log','modmail.log.1','modmail.log.2','modmail.log.3']);
  const plain=[];createLogger({color:false,write:line=>plain.push(line)}).info('startup','plain');assert.ok(!plain[0].includes('\x1b'));
});

test('error logs expose known troubleshooting hints without raw API data, tokens or message content',()=>{
  const secret='DO_NOT_LOG_PRIVATE_MESSAGE_OR_TOKEN',lines=[];
  const logger=createLogger({color:false,write:line=>lines.push(line)});
  logger.error('command reply',Object.assign(new Error(secret),{code:50013,requestBody:{content:secret}}));
  logger.error('startup',Object.assign(new Error(secret),{code:'TokenInvalid'}));
  logger.error('gateway',new Error('Used disallowed intents'));
  logger.error('command plugin',new Error(secret));
  assert.match(lines.join('\n'),/Missing Discord permissions/);assert.match(lines.join('\n'),/Bot token is invalid/);assert.match(lines.join('\n'),/Enable Message Content Intent/);assert.ok(!lines.join('').includes(secret));
  assert.match(safeError(new Error('delivery',{cause:Object.assign(new Error(secret),{code:50007})})),/Cannot send DMs/);
});

async function runBot(t,scenario) {
  const root=await temp(t),cfg={guildId:'100000000000000001',categoryId:null,logChannelId:null,staffRoleIds:['100000000000000004'],enabledPlugins:scenario==='ready'?['example']:[]};
  await writeFile(join(root,'config.json'),scenario==='bad-config'?'{ invalid':JSON.stringify(cfg));
  const fixture=join(root,'gateway-fixture.mjs');
  const discordURL=pathToFileURL(resolve('node_modules/discord.js/src/index.js')).href;
  const botURL=pathToFileURL(resolve('src/bot.js')).href;
  await writeFile(fixture,`import { Client, Events } from ${JSON.stringify(discordURL)};
import { DiscordTransport } from ${JSON.stringify(botURL)};
DiscordTransport.prototype.guild=async function(){return {id:this.config.guildId,name:'Synthetic Staff Server',ownerId:'100000000000000009'};};
DiscordTransport.prototype.verify=async function(){if(process.env.TEST_SCENARIO==='permissions')throw Object.assign(new Error('PRIVATE_API_BODY'),{code:50013});};
Client.prototype.login=async function(){if(process.env.TEST_SCENARIO==='intents')throw new Error('Used disallowed intents');this.user={id:'100000000000000008',tag:'Synthetic Bot#0001'};setImmediate(()=>{this.emit(Events.ShardReady,0);this.emit(Events.ClientReady,this);});return 'synthetic';};
Client.prototype.destroy=async function(){};
`);
  const child=spawn(process.execPath,['--import',fixture,resolve(scenario==='pterodactyl'?'scripts/pterodactyl-start.js':'src/main.js')],{cwd:root,env:{...process.env,DISCORD_TOKEN:'SYNTHETIC_TOKEN_DO_NOT_LOG',DATA_DIR:join(root,'data'),CONFIG_PATH:join(root,'config.json'),PLUGIN_DIR:resolve('plugins'),LOG_COLOR:'true',NO_COLOR:undefined,MODMAIL_HOSTING:'',MODMAIL_GUILD_ID:'100000000000000001',MODMAIL_STAFF_ROLE_IDS:'100000000000000004',LOG_VIEWER_URL:'',TEST_SCENARIO:scenario},stdio:['ignore','pipe','pipe']});
  let output='',errors='',signaled=false;
  const timer=setTimeout(()=>child.kill('SIGKILL'),10000);
  child.stdout.on('data',chunk=>{output+=chunk;if(['ready','pterodactyl'].includes(scenario) && output.includes('Ready: moderator inbox') && !signaled){signaled=true;child.kill('SIGINT');}});
  child.stderr.on('data',chunk=>{errors+=chunk;});
  const result=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}));});clearTimeout(timer);
  const file=await readFile(join(root,'data/logs/modmail.log'),'utf8');
  assert.ok(!(output+errors+file).includes('SYNTHETIC_TOKEN_DO_NOT_LOG'));assert.ok(!(output+errors+file).includes('PRIVATE_API_BODY'));
  return {...result,output,file,errors};
}
test('real main startup logs identity, prefix, plugin load, readiness and clean SIGINT shutdown',async t=>{
  const result=await runBot(t,'ready');assert.equal(result.code,0);assert.equal(result.signal,null);
  for(const text of ["AARON'S SUPPORT",'Logging level: INFO','Shard 0 connected','Logged in as Synthetic Bot','Synthetic Staff Server','Prefix: .','Staff role IDs:','Inbox setup is incomplete','Loaded plugin: example','Active conversations: 0','Ready: moderator inbox','Stopped with exit code 0'])assert.ok(result.output.includes(text),text);
  assert.ok(result.output.includes('\x1b[35m'));assert.ok(!result.file.includes('\x1b'));
});
test('startup configuration, privileged intent and permission failures are explained and exit cleanly',async t=>{
  for(const [scenario,hint] of [['bad-config','Invalid JSON or syntax'],['intents','Enable Message Content Intent'],['permissions','Missing Discord permissions']]) {
    const result=await runBot(t,scenario);assert.equal(result.code,1,scenario);assert.equal(result.signal,null);assert.ok(result.output.includes(hint),result.output);assert.ok(!result.output.includes('Ready: moderator inbox'));
  }
});


test('Pterodactyl entry point logs preparation and readiness and persists its log outside app',async t=>{
  const result=await runBot(t,'pterodactyl');assert.equal(result.code,0);assert.equal(result.signal,null);
  for(const text of ['Preparing Pterodactyl configuration','Pterodactyl configuration ready','Hosting: Pterodactyl','Ready: moderator inbox'])assert.ok(result.output.includes(text),result.output);
  assert.match(result.file,/Pterodactyl configuration ready/);
});

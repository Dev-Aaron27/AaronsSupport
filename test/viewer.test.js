import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm,writeFile,mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { Archives } from '../src/archive.js';
import { LogViewer } from '../src/viewer.js';

async function fixture(t) {
  const dir=await mkdtemp(join(tmpdir(),'viewer-')),store=new Store(dir),archives=new Archives(dir);
  let staff=true;
  const transport={member:async()=>({staff}),isStaff:member=>member.staff,report:()=>{}};
  const fetcher=async url=>new Response(JSON.stringify(url.endsWith('/oauth2/token')?{access_token:'synthetic-test-token'}:{id:'staff-user'}),{status:200});
  const viewer=new LogViewer({url:'http://127.0.0.1:8787',clientId:'test-client',clientSecret:'synthetic-test-secret',port:0},store,archives,transport,fetcher);
  const address=await viewer.start();const base=`http://127.0.0.1:${address.port}`;
  t.after(async()=>{await viewer.stop();store.close();await rm(dir,{recursive:true,force:true});});
  const request=(path,options={})=>fetch(base+path,{redirect:'manual',...options});
  const login=async()=>{
    const response=await request('/login'),location=new URL(response.headers.get('location')),browser=response.headers.get('set-cookie').split(';')[0];
    const callback=await request(`/callback?state=${location.searchParams.get('state')}&code=test-code`,{headers:{cookie:browser}});
    assert.equal(callback.status,302);return callback.headers.get('set-cookie').split(';')[0];
  };
  return {store,archives,viewer,dir,request,login,setStaff:value=>{staff=value;}};
}

test('OAuth viewer binds state to the browser, blocks anonymous logs and rechecks roles on every request',async t=>{
  const {viewer,request,login,setStaff,store}=await fixture(t);
  const ticket=store.createTicket('member');
  assert.equal((await request(`/tickets/${ticket.id}/`)).status,302);
  const start=await request('/login'),state=new URL(start.headers.get('location')).searchParams.get('state');
  assert.equal((await request(`/callback?state=${state}&code=test`)).status,400);
  assert.equal((await request('/callback?state=made-up&code=test')).status,400);
  const cookie=await login();
  const transcript=await request(`/tickets/${ticket.id}/`,{headers:{cookie}});
  assert.equal(transcript.status,200);assert.match(await transcript.text(),/Conversation #1/);
  assert.equal(transcript.headers.get('cache-control'),'no-store');
  setStaff(false);assert.equal((await request(`/tickets/${ticket.id}/`,{headers:{cookie}})).status,403);
  assert.equal(viewer.sessions.size,0);
});

test('OAuth attachment routes cannot read other files and sessions support expiration/revocation/CSRF-safe logout',async t=>{
  const {store,archives,viewer,dir,request,login}=await fixture(t);
  const ticket=store.createTicket('member');await mkdir(join(dir,'attachments','1'),{recursive:true});await writeFile(join(dir,'attachments','1','a.txt'),'safe');
  store.addMessage(ticket,{id:'source',channelId:'dm',author:{id:'member',username:'Member'}},'member','hello',[{id:'a',name:'a.txt',path:'attachments/1/a.txt',size:4}]);
  let cookie=await login();const headers={cookie};
  const file=await request('/tickets/1/attachments/1/a.txt',{headers});assert.equal(file.status,200);assert.equal(await file.text(),'safe');assert.match(file.headers.get('content-disposition'),/attachment/);
  assert.equal((await request('/tickets/1/attachments/2/secret.txt',{headers})).status,404);
  assert.equal((await request('/tickets/1/attachments/%2e%2e/inbox.sqlite',{headers})).status,404);
  assert.equal((await request('/logout',{method:'POST',headers:{...headers,origin:'https://attacker.invalid'}})).status,403);
  assert.equal((await request('/logout',{method:'POST',headers:{...headers,origin:viewer.url}})).status,302);
  assert.equal((await request('/',{headers})).status,302);
  cookie=await login();for(const session of viewer.sessions.values())session.expires=0;
  assert.equal((await request('/',{headers:{cookie}})).status,302);
  await login();viewer.revoke();assert.equal(viewer.sessions.size,0);
});

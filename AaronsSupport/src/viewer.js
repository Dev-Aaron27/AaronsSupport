import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { join } from 'node:path';
import { escapeHtml } from './archive.js';

const nonce=()=>randomBytes(32).toString('base64url');
const cookie=(req,key)=>String(req.headers.cookie || '').split(';').map(s=>s.trim()).find(s=>s.startsWith(`${key}=`))?.slice(key.length+1);
const equal=(a,b)=>typeof a==='string' && typeof b==='string' && Buffer.byteLength(a)===Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a),Buffer.from(b));
export class LogViewer {
  constructor({url,clientId,clientSecret,port=8787,host='127.0.0.1'},store,archives,transport,fetcher=fetch) {
    const parsed=new URL(url);
    if(parsed.username || parsed.password || parsed.pathname!=='/' || parsed.search || parsed.hash || parsed.protocol!=='https:' && !(parsed.protocol==='http:' && ['localhost','127.0.0.1','[::1]'].includes(parsed.hostname)))throw new Error('LOG_VIEWER_URL must be an HTTPS origin (HTTP only on localhost).');
    if(!clientId || !clientSecret)throw new Error('OAuth client ID and secret are required for the log viewer.');
    Object.assign(this,{url:parsed.origin,clientId,clientSecret,port,host,store,archives,transport,fetcher});
    this.secure=parsed.protocol==='https:';this.states=new Map();this.sessions=new Map();
  }
  setCookie(res,key,value,maxAge) {res.setHeader('Set-Cookie',`${key}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${this.secure?'; Secure':''}`);}
  revoke(){this.sessions.clear();this.states.clear();}
  async start(){this.server=createServer((req,res)=>this.request(req,res).catch(error=>{this.transport.report(error,'log viewer');if(!res.headersSent){res.statusCode=500;res.end('Unable to complete request.');}else res.destroy();}));await new Promise((resolve,reject)=>{this.server.once('error',reject);this.server.listen(this.port,this.host,resolve);});return this.server.address();}
  async stop(){this.revoke();if(this.server)await new Promise(resolve=>this.server.close(resolve));}
  async api(path,options={}) {const response=await this.fetcher(`https://discord.com/api/v10${path}`,{...options,signal:AbortSignal.timeout(10000)});if(!response.ok)throw new Error('Discord authentication request failed.');return response.json();}
  redirect(res,path){res.writeHead(302,{Location:path});res.end();}
  async request(req,res) {
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('Content-Security-Policy',"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
    const now=Date.now();for(const map of [this.states,this.sessions])for(const [key,item]of map)if(item.expires<=now)map.delete(key);
    const url=new URL(req.url,this.url);
    if(req.method==='GET' && url.pathname==='/health'){res.end('ok');return;}
    if(req.method==='GET' && url.pathname==='/login') {
      if(this.states.size>=1000){res.writeHead(429);res.end('Try again later.');return;}
      const state=nonce(),browser=nonce();this.states.set(state,{browser,expires:now+300000});this.setCookie(res,'mm_oauth',browser,300);
      const location=new URL('https://discord.com/oauth2/authorize');location.search=new URLSearchParams({client_id:this.clientId,redirect_uri:`${this.url}/callback`,response_type:'code',scope:'identify',state}).toString();
      return this.redirect(res,location.href);
    }
    if(req.method==='GET' && url.pathname==='/callback') {
      const state=url.searchParams.get('state'),pending=this.states.get(state);this.states.delete(state);
      if(!pending || !equal(pending.browser,cookie(req,'mm_oauth')) || !url.searchParams.get('code')){res.writeHead(400);res.end('Invalid or expired OAuth state.');return;}
      const token=await this.api('/oauth2/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:this.clientId,client_secret:this.clientSecret,grant_type:'authorization_code',code:url.searchParams.get('code'),redirect_uri:`${this.url}/callback`})});
      const user=await this.api('/users/@me',{headers:{Authorization:`Bearer ${token.access_token}`}});
      if(!this.transport.isStaff(await this.transport.member(user.id))){res.writeHead(403);res.end('Current server staff membership is required.');return;}
      if(this.sessions.size>=1000){res.writeHead(429);res.end('Try again later.');return;}
      const session=nonce();this.sessions.set(session,{userId:user.id,expires:now+3600000});this.setCookie(res,'mm_session',session,3600);return this.redirect(res,'/');
    }
    const sessionId=cookie(req,'mm_session'),session=this.sessions.get(sessionId);
    if(!session)return this.redirect(res,'/login');
    // Recheck current roles for every transcript and attachment, including downloads.
    if(!this.transport.isStaff(await this.transport.member(session.userId))){this.sessions.delete(sessionId);res.writeHead(403);res.end('Access revoked.');return;}
    if(req.method==='POST' && url.pathname==='/logout'){
      if(req.headers.origin!==this.url){res.writeHead(403);res.end('Invalid origin.');return;}
      this.sessions.delete(sessionId);this.setCookie(res,'mm_session','',0);return this.redirect(res,'/login');
    }
    if(req.method!=='GET'){res.writeHead(405);res.end('Method not allowed.');return;}
    if(url.pathname==='/') {
      const rows=this.store.recentTickets();res.setHeader('Content-Type','text/html; charset=utf-8');
      res.end(`<!doctype html><html lang="en"><meta charset="utf-8"><title>Private modmail logs</title><h1>Private modmail logs</h1><p>Most recent 100 conversations. Use Discord's logs command for member searches.</p><ul>${rows.map(t=>`<li><a href="/tickets/${t.id}/">#${t.id}</a> · Member ${escapeHtml(t.user_id)} · ${escapeHtml(t.status)}</li>`).join('')}</ul><form method="post" action="/logout"><button>Log out</button></form></html>`);return;
    }
    const match=/^\/tickets\/(\d+)(\/.*)?$/.exec(url.pathname);const ticket=match?this.store.ticket(Number(match[1])):null;
    if(!ticket){res.writeHead(404);res.end('Not found.');return;}
    if(!match[2])return this.redirect(res,`/tickets/${ticket.id}/`);
    const messages=this.store.messages(ticket.id),revisions=this.store.revisions(ticket.id);
    if(match[2]==='/'){res.setHeader('Content-Type','text/html; charset=utf-8');res.end(this.archives.html(ticket,messages));return;}
    if(match[2]==='/archive' && ticket.status==='closed' && ticket.archive_path)return this.file(res,ticket.archive_path,`ticket-${ticket.id}.zip`);
    if(match[2].startsWith('/attachments/')) {
      const path=decodeURIComponent(match[2].slice(1));
      const allowed=[...messages.flatMap(m=>m.attachments),...revisions.flatMap(r=>JSON.parse(r.attachments))];
      const attachment=allowed.find(a=>a.path===path && path.startsWith(`attachments/${ticket.id}/`));
      if(attachment)return this.file(res,join(this.archives.dir,attachment.path),`attachment-${attachment.id}`);
    }
    res.writeHead(404);res.end('Not found.');
  }
  async file(res,path,name) {try{const info=await stat(path);res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Length':info.size,'Content-Disposition':`attachment; filename="${name}"`});await pipeline(createReadStream(path),res);}catch(error){if(!res.headersSent){res.writeHead(404);res.end('File unavailable.');}else throw error;}}
}

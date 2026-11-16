'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http');const{spawn,spawnSync}=require('node:child_process');const{once}=require('node:events');
let checks=0;function ok(v,m){assert.ok(v,m);checks++;}
async function freePort(){const s=http.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;}
async function wait(url){for(let i=0;i<100;i++){try{const r=await fetch(url);if(r.status<500)return;}catch{}await new Promise(r=>setTimeout(r,40));}throw new Error('Not ready');}
(async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ua-funnel-'));let proxy,dashboard,edge;
 const mock=http.createServer((req,res)=>{ok(req.headers.authorization==='Bearer fixture-provider-key','provider credential injected');ok(!req.headers['x-ua-public-gateway'],'public marker not leaked');if(req.url.includes('chat/completions')){res.writeHead(200,{'content-type':'text/event-stream'});res.write('data: {"choices":[{"delta":{"content":"first"}}]}\n\n');setTimeout(()=>res.end('data: {"choices":[{"delta":{"content":"last"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'),350);}else{res.writeHead(200,{'content-type':'application/json'});res.end('{"data":[]}');}});await new Promise(r=>mock.listen(0,'127.0.0.1',r));
 const pp=await freePort(),dp=await freePort(),ep=await freePort();const cfg={host:'127.0.0.1',port:pp,publicMode:true,authToken:'fixture-proxy-token-00000000000000000000',defaultUpstream:'fixture',upstreams:{fixture:{baseUrl:`http://127.0.0.1:${mock.address().port}/v1`,apiKey:'fixture-provider-key'}}};const config=path.join(dir,'config.json');fs.writeFileSync(config,JSON.stringify(cfg));
 const env={...process.env,UA_PROXY_CONFIG:config,UA_PROXY_METRICS:path.join(dir,'metrics.json'),UA_PROXY_HISTORY:path.join(dir,'history.sqlite'),UA_DASHBOARD_PORT:String(dp),UA_PROXY_UNIT:'ua-edge-fixture-absent.service',XDG_CONFIG_HOME:path.join(dir,'caddy-config'),XDG_DATA_HOME:path.join(dir,'caddy-data')};
 const password='fixture-dashboard-password-123456';const hashed=spawnSync(path.join(__dirname,'caddy-funnel'),['hash-password','--algorithm','argon2id'],{input:password+'\n',encoding:'utf8'}).stdout.trim();
 const metadata=JSON.parse(fs.readFileSync(path.join(__dirname,'runtime','public-access.json')));const creds=JSON.parse(fs.readFileSync(path.join(__dirname,'remote-credentials.json')));
 let caddy=fs.readFileSync(path.join(__dirname,'Funnel.Caddyfile'),'utf8').split('8790').join(String(ep)).split('8788').join(String(dp)).split(new URL(metadata.origin).hostname).join('edge-fixture.ts.net').split(creds.passwordHash).join(hashed);const caddyfile=path.join(dir,'Caddyfile');fs.writeFileSync(caddyfile,caddy);
 function start(file){const c=spawn(process.execPath,[path.join(__dirname,file)],{env,stdio:['ignore','ignore','pipe']});c.stderr.on('data',()=>{});return c;}
 async function stop(c){c.kill('SIGTERM');await once(c,'exit');}
 const basic='Basic '+Buffer.from('fixture-user:'+password).toString('base64'),bearer='Bearer '+cfg.authToken;const base=`http://127.0.0.1:${ep}`;
 try{
  proxy=start('server.js');dashboard=start('dashboard.js');await wait(`http://127.0.0.1:${pp}/_health`);await wait(`http://127.0.0.1:${dp}`);
  edge=spawn(path.join(__dirname,'caddy-funnel'),['run','--config',caddyfile,'--adapter','caddyfile'],{env,stdio:['ignore','ignore','pipe']});edge.stderr.on('data',()=>{});await wait(base);
  let r=await fetch(base+'/');ok(r.status===401,'anonymous dashboard blocked');ok(r.headers.get('www-authenticate')?.includes('Basic'),'browser login challenge');
  r=await fetch(base+'/api/session');ok(r.status===401&&!r.headers.get('set-cookie'),'anonymous session blocked');
  r=await fetch(base+'/api/action',{method:'POST',headers:{'content-type':'application/json','x-ua-public-gateway':'1'},body:JSON.stringify({action:'credential.read',input:{scope:'proxy'}})});ok(r.status===401,'spoofed gateway header cannot expose secrets');
  r=await fetch(base+'/',{headers:{authorization:'Basic '+Buffer.from('fixture-user:wrong').toString('base64')}});ok(r.status===401,'wrong password blocked');
  r=await fetch(base+'/',{headers:{authorization:basic}});ok(r.status===200,'correct dashboard login');
  r=await fetch(base+'/api/session',{headers:{authorization:basic}});const cookie=r.headers.get('set-cookie'),csrf=(await r.json()).csrf;ok(cookie.includes('Secure')&&cookie.includes('HttpOnly')&&cookie.includes('SameSite=Strict'),'secure public session cookie');
  const adminHeaders={authorization:basic,cookie:cookie.split(';')[0],'content-type':'application/json','x-csrf-token':csrf,origin:'https://edge-fixture.ts.net'};
  r=await fetch(base+'/api/action',{method:'POST',headers:adminHeaders,body:JSON.stringify({action:'credential.read',input:{scope:'proxy'}})});ok(r.status===200&&(await r.json()).value===cfg.authToken,'authenticated remote View action works');
  r=await fetch(base+'/api/action',{method:'POST',headers:{...adminHeaders,origin:'https://evil.example'},body:'{}'});ok(r.status===403,'foreign origin rejected before backend rewrite');
  r=await fetch(base+'/v1/models');ok(r.status===401,'public API requires proxy key');r=await fetch(base+'/v1/models',{headers:{authorization:basic}});ok(r.status===401,'dashboard password not accepted as API key');
  r=await fetch(base+'/fixture/v1/models',{headers:{authorization:bearer}});ok(r.status===200,'named channel with valid key');ok(!r.headers.get('set-cookie'),'no upstream cookies returned');
  const began=Date.now();r=await fetch(base+'/v1/chat/completions',{method:'POST',headers:{authorization:bearer,'content-type':'application/json'},body:JSON.stringify({model:'fixture/model',messages:[]})});const reader=r.body.getReader();const first=await reader.read();ok(new TextDecoder().decode(first.value).includes('first')&&Date.now()-began<300,'stream bytes arrive before completion');while(!(await reader.read()).done){}
  cfg.publicMode=false;fs.writeFileSync(config,JSON.stringify(cfg));await stop(proxy);proxy=start('server.js');await wait(`http://127.0.0.1:${pp}/_health`);
  r=await fetch(base+'/v1/models');ok(r.status===401,'public API stays protected in local passthrough mode');r=await fetch(base+'/v1/models',{headers:{authorization:bearer}});ok(r.status===200,'public key still works in passthrough mode');
  // Check origins and Basic gateway protections without calling any real provider.
  console.log(`Funnel edge: ${checks} checks passed: public dashboard auth, origin/CSRF boundary, secure cookies, explicit key reveal, bearer-only API, named routes, SSE streaming, and fail-closed local passthrough. Fixtures only.`);
 }finally{if(edge&&edge.exitCode===null)await stop(edge);if(dashboard&&dashboard.exitCode===null)await stop(dashboard);if(proxy&&proxy.exitCode===null)await stop(proxy);mock.closeAllConnections();await new Promise(r=>mock.close(r));fs.rmSync(dir,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});

'use strict';
const assert=require('node:assert/strict');const fs=require('node:fs');const os=require('node:os');const path=require('node:path');const http=require('node:http');const {spawn}=require('node:child_process');const {once}=require('node:events');
(async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ua-proxy-test-'));let child,seen;
 const upstream=http.createServer((req,res)=>{let raw='';req.on('data',c=>raw+=c);req.on('end',()=>{seen={url:req.url,headers:req.headers,body:raw};if(req.url.includes('stream')){res.writeHead(200,{'content-type':'text/event-stream'});res.end('data: null\n\ndata: {"choices":[]}\n\ndata: [DONE]\n\n');}else{res.setHeader('content-type','application/json');res.end('{"ok":true}');}});});
 await new Promise(r=>upstream.listen(0,'127.0.0.1',r));const reserve=http.createServer();await new Promise(r=>reserve.listen(0,'127.0.0.1',r));const port=reserve.address().port;await new Promise(r=>reserve.close(r));
 const cfg={host:'127.0.0.1',port,publicMode:true,authToken:'test-proxy-token-00000000000000000000',defaultUpstream:'fixture',upstreams:{fixture:{baseUrl:`http://127.0.0.1:${upstream.address().port}/v1`,apiKey:'fixture-key',headers:{'user-agent':'special-client'},stripBodyKeys:['thinking'],sanitizeSse:true}}};const file=path.join(dir,'config.json');fs.writeFileSync(file,JSON.stringify(cfg));
 try{
  child=spawn(process.execPath,[path.join(__dirname,'server.js')],{env:{...process.env,UA_PROXY_CONFIG:file,UA_PROXY_METRICS:path.join(dir,'metrics.json')},stdio:['ignore','ignore','pipe']});
  let ready=false;for(let i=0;i<40;i++){try{ready=(await fetch(`http://127.0.0.1:${port}/_health`)).ok;if(ready)break;}catch{}await new Promise(r=>setTimeout(r,50));}assert(ready);
  const base=`http://127.0.0.1:${port}`;assert.equal((await fetch(base+'/fixture/v1/models')).status,401);
  const r=await fetch(base+'/fixture/v1/chat/completions?tag=hello',{method:'POST',headers:{authorization:`Bearer ${cfg.authToken}`,'content-type':'application/json',cookie:'never-forward=yes','x-forwarded-for':'bad-ip','user-agent':'wrong-agent'},body:JSON.stringify({model:'mock',thinking:'remove',messages:[]})});assert.equal(r.status,200);
  assert.equal(seen.url,'/v1/chat/completions?tag=hello');assert.equal(seen.headers.authorization,'Bearer fixture-key');assert.equal(seen.headers['user-agent'],'special-client');assert.equal(seen.headers.cookie,undefined);assert.equal(seen.headers['x-forwarded-for'],undefined);assert.equal(JSON.parse(seen.body).thinking,undefined);
  const s=await fetch(base+'/fixture/v1/stream',{headers:{authorization:`Bearer ${cfg.authToken}`}});assert.equal(await s.text(),'data: {"choices":[]}\n\ndata: [DONE]\n\n');
  await new Promise(r=>setTimeout(r,1100));const metrics=JSON.parse(fs.readFileSync(path.join(dir,'metrics.json')));assert.equal(metrics.total,3);assert.equal(metrics.errors,1);assert(!JSON.stringify(metrics).includes('hello'));
  console.log('Proxy integration: auth, route joining, key/header injection, cookie stripping, body rewrite, SSE filtering, and telemetry passed.');
 }finally{if(child){child.kill('SIGTERM');await once(child,'exit');}await new Promise(r=>upstream.close(r));fs.rmSync(dir,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});

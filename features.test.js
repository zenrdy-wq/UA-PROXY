'use strict';
const assert=require('node:assert/strict');const fs=require('node:fs');const os=require('node:os');const path=require('node:path');const http=require('node:http');const {spawn}=require('node:child_process');const {once}=require('node:events');
const {openHistory}=require('./history');const {diagnose}=require('./diagnostics');const {createSseParser}=require('./sse');
let checks=0;function ok(value,message){assert.ok(value,message);checks++;}
async function port(){const s=http.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;}
async function wait(url){for(let n=0;n<80;n++){try{if((await fetch(url)).ok)return;}catch{}await new Promise(r=>setTimeout(r,50));}throw new Error('Server not ready');}
(async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ua-features-'));const historyFile=path.join(dir,'history.sqlite');let proxy,dashboard,browser;let slowClosed=0;
 const upstream=http.createServer((req,res)=>{let raw='';req.on('data',b=>raw+=b);req.on('end',()=>{
  ok(req.headers.authorization==='Bearer fixture-private-key','upstream key injected');ok(req.headers['user-agent']==='fixture-agent','custom user-agent injected');ok(!req.headers['x-ua-source'],'internal marker removed');
  if(req.url==='/v1/models'){res.setHeader('content-type','application/json');res.end(JSON.stringify({data:[{id:'fixture/model'},{id:'fixture/fail'},{id:'fixture/slow'},{id:'fixture/unicode-json'}]}));return;}
  const body=JSON.parse(raw);ok(!body.thinking,'body rewrite retained');
  if(body.model==='fixture/fail'){res.writeHead(403,{'content-type':'application/json'});res.end(JSON.stringify({error:{code:11140,message:'Account restricted due to unusual activity; fixture-private-key '+body.messages.at(-1).content}}));return;}
  if(body.model==='fixture/json'||body.model==='fixture/unicode-json'){
   res.setHeader('content-type','application/json');const b=Buffer.from(JSON.stringify({choices:[{message:{content:'Halo 👋'},finish_reason:'stop'}],usage:{prompt_tokens:4,completion_tokens:5,total_tokens:9}}));const marker=b.indexOf(Buffer.from('👋'));res.write(b.subarray(0,marker+1));setTimeout(()=>res.end(b.subarray(marker+1)),20);return;
  }
  res.writeHead(200,{'content-type':'text/event-stream'});
  if(body.model==='fixture/sse-error'){res.end('event: error\ndata: {"error":{"code":"insufficient_quota","message":"credit exhausted"}}\n\n');return;}
  if(body.model==='fixture/truncated'){res.end('data: {"choices":[{"delta":{"content":"Partial"}}]}\n\n');return;}
  if(body.model==='fixture/slow'){res.write('data: {"choices":[{"delta":{"content":"First"}}]}\n\n');const timer=setInterval(()=>res.write(': keep-alive\n\n'),100);res.on('close',()=>{clearInterval(timer);slowClosed++;});return;}
  const b=Buffer.from('data: null\r\n\r\ndata: {"choices":[{"delta":{"content":"Halo 👋"}}]}\r\n\r\n');const cut=b.indexOf(Buffer.from('👋'))+1;res.write(b.subarray(0,cut));setTimeout(()=>{res.write(b.subarray(cut));res.end('data: {"choices":[{"delta":{"content":" world"},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":4,"total_tokens":7}}\n\ndata: [DONE]\n\n');},50);
 });});
 await new Promise(r=>upstream.listen(0,'127.0.0.1',r));const pp=await port(),dp=await port();const cfg={host:'127.0.0.1',port:pp,publicMode:true,authToken:'fixture-proxy-token-0000000000000000000000',defaultUpstream:'fixture',heartbeatMs:0,upstreams:{fixture:{baseUrl:`http://127.0.0.1:${upstream.address().port}/v1`,apiKey:'fixture-private-key',headers:{'user-agent':'fixture-agent'},stripBodyKeys:['thinking']}}};const configFile=path.join(dir,'config.json');fs.writeFileSync(configFile,JSON.stringify(cfg));const env={...process.env,UA_PROXY_CONFIG:configFile,UA_PROXY_HISTORY:historyFile,UA_PROXY_METRICS:path.join(dir,'metrics.json'),UA_DASHBOARD_PORT:String(dp),UA_PROXY_UNIT:'ua-features-absent.service'};
 function start(file){const c=spawn(process.execPath,[path.join(__dirname,file)],{env,stdio:['ignore','ignore','pipe']});c.stderr.on('data',()=>{});return c;}
 async function stop(c){c.kill('SIGTERM');await once(c,'exit');}
 try{
  proxy=start('server.js');dashboard=start('dashboard.js');const base=`http://127.0.0.1:${dp}`;await wait(`http://127.0.0.1:${pp}/_health`);await wait(base);
  let session;async function login(){const r=await fetch(base+'/api/session');session={cookie:r.headers.get('set-cookie').split(';')[0],csrf:(await r.json()).csrf};}await login();
  const headers=()=>({cookie:session.cookie,'content-type':'application/json','x-csrf-token':session.csrf});
  async function api(url){const r=await fetch(base+url,{headers:headers()});assert.equal(r.status,200);return r.json();}
  function play(model,options={}){return fetch(base+'/api/playground',{method:'POST',headers:headers(),body:JSON.stringify({provider:'fixture',model,messages:[{role:'user',content:'private-prompt-should-never-be-stored'}],...options})});}
  let r=await fetch(base+'/api/playground',{method:'POST',headers:{...headers(),'x-csrf-token':'wrong'},body:'{}'});ok(r.status===403,'playground requires CSRF');
  r=await play('fixture/model',{maxTokens:9000});ok(r.status===400,'output bounds enforced');
  r=await play('fixture/model');let events=(await r.text()).trim().split('\n').map(JSON.parse);ok(events.filter(e=>e.type==='delta').map(e=>e.text).join('')==='Halo 👋 world','stream UTF-8 + CRLF + null filtering');ok(events.some(e=>e.type==='done'&&e.usage.total===7),'stream completed with usage');const requestId=events.find(e=>e.type==='meta').requestId;ok(Boolean(requestId),'request linked to history');
  r=await play('fixture/unicode-json',{stream:false});events=(await r.text()).trim().split('\n').map(JSON.parse);ok(events.some(e=>e.type==='delta'&&e.text==='Halo 👋'),'JSON UTF-8 split handled');
  r=await play('fixture/fail');events=(await r.text()).trim().split('\n').map(JSON.parse);ok(events.some(e=>e.kind==='restricted'&&e.code==='11140'),'classified restriction');ok(!JSON.stringify(events).includes('fixture-private-key')&&!JSON.stringify(events).includes('private-prompt'),'error stream contains no raw error secrets');
  r=await play('fixture/sse-error');events=(await r.text()).trim().split('\n').map(JSON.parse);ok(events.some(e=>e.type==='error'&&e.kind==='quota'),'SSE error recognized');ok(!events.some(e=>e.type==='done'),'SSE failure not successful');
  r=await play('fixture/truncated');events=(await r.text()).trim().split('\n').map(JSON.parse);ok(events.some(e=>e.type==='error'),'truncated stream surfaced');
  let h=await api('/api/history?range=all');ok(h.total===5,'all playground requests recorded');ok(h.rows.some(row=>row.upstreamStatus===200&&row.status===502&&row.diagnosis.kind==='quota'),'SSE error also visible in history');ok(!JSON.stringify(h).includes('private-prompt')&&!JSON.stringify(h).includes('fixture-private-key'),'history has no prompts/keys');
  const detail=await api('/api/request?id='+requestId);ok(detail.id===requestId&&detail.origin==='playground','request detail links to origin');
  h=await api('/api/history?status=errors&provider=fixture&range=7d&limit=1');ok(h.total===3&&h.pages===3&&h.rows.length===1,'filters and pagination');
  h=await api('/api/history?q='+encodeURIComponent("%' OR 1=1 --"));ok(h.total===0,'search parameterized and wildcard escaped');
  await stop(proxy);proxy=start('server.js');await wait(`http://127.0.0.1:${pp}/_health`);h=await api('/api/history?range=all');ok(h.total===5,'history survives proxy restart without duplicate migration');
  await stop(dashboard);dashboard=start('dashboard.js');await wait(base);await login();h=await api('/api/history?range=all');ok(h.total===5,'history survives dashboard restart');
  const ac=new AbortController();r=await fetch(base+'/api/playground',{method:'POST',headers:headers(),signal:ac.signal,body:JSON.stringify({provider:'fixture',model:'fixture/slow',messages:[{role:'user',content:'stop me'}]})});const reader=r.body.getReader();await reader.read();await new Promise(r=>setTimeout(r,80));ac.abort();try{await reader.read();}catch{}await new Promise(r=>setTimeout(r,300));ok(slowClosed>0,'cancellation closes upstream');
  h=await api('/api/history?range=all');ok(h.rows.some(row=>row.status===499),'cancelled stream recorded');
  const {chromium}=require('./qa/node_modules/playwright');browser=await chromium.launch({executablePath:'/opt/google/chrome/chrome',headless:true,args:['--no-sandbox']});const page=await browser.newPage({viewport:{width:1440,height:1050}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base+'/#activity');await page.waitForSelector('#activity-requests .inspect-request');await page.locator('#history-status').selectOption('errors');await page.waitForFunction(()=>document.querySelector('#history-summary').textContent.includes('failed'));await page.locator('#activity-requests [aria-label="Inspect request 403"]').first().click();await page.waitForSelector('#request-dialog[open]');ok((await page.locator('#request-detail').innerText()).includes('Provider error code'),'inspector renders');await page.screenshot({path:__dirname+'/qa/error-inspector.png'});await page.keyboard.press('Escape');
  await page.goto(base+'/#playground');await page.waitForFunction(()=>document.querySelector('#pg-provider').options.length===1);await page.locator('#pg-load-models').click();await page.waitForFunction(()=>document.querySelector('#pg-model-list').options.length===4);await page.locator('#pg-model').fill('fixture/model');await page.locator('#pg-prompt').fill('hello fixture');await page.locator('#pg-send').click();await page.waitForFunction(()=>document.querySelector('#pg-generation-meta').textContent.startsWith('Done'));ok((await page.locator('.chat-turn.assistant .chat-bubble').innerText())==='Halo 👋 world','playground UI streams');await page.screenshot({path:__dirname+'/qa/playground-desktop.png',fullPage:true});
  await page.locator('#pg-model').fill('fixture/slow');await page.locator('#pg-prompt').fill('cancel fixture');await page.locator('#pg-send').click();await page.waitForFunction(()=>document.querySelector('.chat-turn.assistant .chat-bubble').textContent==='First');await page.locator('#pg-stop').click();await page.waitForFunction(()=>document.querySelector('#pg-generation-meta').textContent.startsWith('Stopped'));ok(await page.locator('#pg-send').isEnabled(),'stop restores send button');
  await page.setViewportSize({width:390,height:844});await page.waitForTimeout(300);ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'mobile playground fits');await page.screenshot({path:__dirname+'/qa/playground-mobile.png',fullPage:true,animations:'disabled'});ok(errors.length===0,'no browser JS errors');await browser.close();browser=null;
  // Retention and migration in a separate database, without modifying live data.
  const small=openHistory(path.join(dir,'retention.sqlite'));small.record({id:'old',at:Date.now()-31*86400000,method:'GET',upstream:'fixture',endpoint:'/models',status:200,durationMs:10});small.prune();ok(small.get('old')===null,'30-day retention');small.close();
  ok(diagnose(401,{},'proxy').kind==='proxy_auth','proxy/provider auth distinguished');
  console.log(`Feature tests: ${checks} assertions passed, including browser QA, streaming/cancellation, diagnostics, restart persistence, retention, privacy, and filtering. Mock providers only.`);
 }finally{
  if(browser)await browser.close();if(dashboard&&dashboard.exitCode===null)await stop(dashboard);if(proxy&&proxy.exitCode===null)await stop(proxy);upstream.closeAllConnections();await new Promise(r=>upstream.close(r));fs.rmSync(dir,{recursive:true,force:true});
 }
})().catch(e=>{console.error(e);process.exitCode=1;});

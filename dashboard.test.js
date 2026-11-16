'use strict';
const assert=require('node:assert/strict');
const http=require('node:http');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawn}=require('node:child_process');
const {once}=require('node:events');
const {createTelemetry}=require('./telemetry');
let checks=0;
function ok(v,msg){assert.ok(v,msg);checks++;}
(async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ua-dashboard-'));let child;
 const mock=http.createServer((req,res)=>{
  ok(req.headers.authorization==='Bearer fixture-private-key','server-side key used');
  res.setHeader('content-type','application/json');
  if(req.url==='/v1/models')res.end(JSON.stringify({data:[{id:'fixture/model'}]}));
  else res.end(JSON.stringify({choices:[{message:{content:'OK'}}]}));
 });
 await new Promise(r=>mock.listen(0,'127.0.0.1',r));
 const reserve=http.createServer();await new Promise(r=>reserve.listen(0,'127.0.0.1',r));const port=reserve.address().port;await new Promise(r=>reserve.close(r));
 const configPath=path.join(dir,'config.json');
 const config={host:'127.0.0.1',port:18787,publicMode:true,authToken:'fixture-proxy-token-0000000000000000000',heartbeatMs:20000,defaultUpstream:'fixture',upstreams:{fixture:{baseUrl:`http://127.0.0.1:${mock.address().port}/v1`,apiKey:'fixture-private-key',headers:{'user-agent':'Fixture','x-secret-key':'fixture-header-secret'}}}};
 fs.writeFileSync(configPath,JSON.stringify(config),{mode:0o600});
 try{
  child=spawn(process.execPath,[path.join(__dirname,'dashboard.js')],{env:{...process.env,UA_PROXY_HISTORY:path.join(dir,'history.sqlite'),UA_PROXY_CONFIG:configPath,UA_DASHBOARD_PORT:String(port),UA_PROXY_UNIT:'ua-proxy-fixture-absent.service'},stdio:['ignore','pipe','pipe']});
  const errors=[];child.stderr.on('data',b=>errors.push(String(b)));
  await Promise.race([once(child.stdout,'data'),new Promise((_,rej)=>setTimeout(()=>rej(new Error('startup timeout '+errors.join(''))),5000))]);
  const base=`http://127.0.0.1:${port}`;
  let r=await fetch(base+'/');ok(r.status===200,'static document');ok(r.headers.get('content-security-policy').includes("frame-ancestors 'none'"),'CSP');
  r=await fetch(base+'/api/state');ok(r.status===401,'API needs session');
  const foreignHostStatus=await new Promise((resolve,reject)=>{const q=http.get(base+'/api/session',{headers:{host:'evil.example'}},response=>{response.resume();resolve(response.statusCode);});q.on('error',reject);});ok(foreignHostStatus===403,'DNS rebinding host rejected');
  r=await fetch(base+'/api/session',{headers:{origin:'https://evil.example'}});ok(r.status===403,'foreign origin rejected');
  r=await fetch(base+'/api/session',{headers:{'sec-fetch-site':'cross-site'}});ok(r.status===403,'foreign fetch site rejected');
  r=await fetch(base+'/api/session');const cookie=r.headers.get('set-cookie');const token=(await r.json()).csrf;
  ok(cookie.includes('HttpOnly')&&cookie.includes('SameSite=Strict'),'cookie protections');
  const headers={cookie:cookie.split(';')[0],'content-type':'application/json','x-csrf-token':token};
  async function post(action,input={},extra={}){return fetch(base+'/api/action',{method:'POST',headers:{...headers,...extra},body:JSON.stringify({action,input})});}
  r=await fetch(base+'/api/state',{headers});let raw=await r.text();ok(!raw.includes('fixture-private-key')&&!raw.includes(config.authToken)&&!raw.includes('fixture-header-secret'),'all config secrets redacted');
  const state=JSON.parse(raw);ok(state.config.upstreams.fixture.keyConfigured,'key status returned');
  r=await post('models',{name:'fixture'},{'x-csrf-token':'bad'});ok(r.status===403,'CSRF rejected');
  r=await post('models',{name:'fixture'});ok((await r.json()).models[0]==='fixture/model','catalog works');
  r=await post('test',{name:'fixture',model:'fixture/model'});ok((await r.json()).reply==='OK','model probe works');
  r=await post('provider.save',{name:'fixture',baseUrl:config.upstreams.fixture.baseUrl,headers:{'user-agent':'Updated'}});ok(r.status===200,'edit provider');
  let saved=JSON.parse(fs.readFileSync(configPath));ok(saved.upstreams.fixture.apiKey==='fixture-private-key'&&saved.upstreams.fixture.headers['x-secret-key']==='fixture-header-secret','blank edit retains hidden credentials');
  ok((fs.statSync(configPath).mode&0o777)===0o600&&(fs.statSync(configPath+'.bak').mode&0o777)===0o600,'private config and backup');
  r=await post('provider.save',{name:'new',baseUrl:'https://example.test/v1',apiKey:'new-key',headers:{}});ok(r.status===200,'add provider');
  r=await post('provider.delete',{name:'fixture'});ok(r.status===400,'default cannot be deleted');
  r=await post('provider.delete',{name:'new'});ok(r.status===200,'delete provider');
  const before=fs.readFileSync(configPath,'utf8');r=await post('settings.save',{port});ok(r.status===400,'port collision rejected');ok(fs.readFileSync(configPath,'utf8')===before,'invalid edit leaves config untouched');
  r=await post('provider.save',{name:'bad',baseUrl:'https://user:pass@example.test/v1'});ok(r.status===400,'URL credentials refused');
  r=await post('settings.save',{heartbeatMs:-1});ok(r.status===400,'invalid setting refused');
  const {EventEmitter}=require('node:events');const metricsPath=path.join(dir,'metrics.json');const telemetry=createTelemetry(metricsPath);const response=new EventEmitter();response.writableFinished=true;response.statusCode=403;telemetry.track({url:'/fixture/v1/models?key=never-store',method:'GET'},response,{name:'fixture'});response.emit('finish');response.emit('close');telemetry.close();
  const metrics=JSON.parse(fs.readFileSync(metricsPath));ok(metrics.total===1&&metrics.active===0&&metrics.errors===1,'telemetry counts close/finish once');ok(!JSON.stringify(metrics).includes('never-store'),'telemetry strips query');
  console.log(`Dashboard integration: ${checks} checks passed (mock provider only).`);
 }finally{
  if(child){child.kill('SIGTERM');await once(child,'exit');}await new Promise(r=>mock.close(r));fs.rmSync(dir,{recursive:true,force:true});
 }
})().catch(e=>{console.error(e);process.exitCode=1;});

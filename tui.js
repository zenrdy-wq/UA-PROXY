#!/usr/bin/env node
'use strict';
const readline = require('node:readline');
const { spawn } = require('node:child_process');
const { snapshot, perform, sanitize } = require('./manager');
const { loadConfig } = require('./config-store');
const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
const color = !process.env.NO_COLOR && process.env.TERM !== 'dumb';
const C = { reset:color?'\x1b[0m':'', fg:color?'\x1b[38;2;220;225;237m':'',
 muted:color?'\x1b[38;2;115;128;150m':'', blue:color?'\x1b[38;2;120;176;255m':'',
 green:color?'\x1b[38;2;111;216;166m':'', red:color?'\x1b[38;2;255;137;145m':'',
 bg:color?'\x1b[48;2;18;21;27m':'', side:color?'\x1b[48;2;25;29;37m':'',
 selected:color?'\x1b[48;2;44;64;94m':'', bold:color?'\x1b[1m':'' };
const sections=['Overview','Providers','Activity','Models','Settings'];
let state, section=0, selected=0, focus='content', detail=null, busy=false, message='', error=false;
let prompt=null, timer, closed=false, catalog=[], catalogProvider='', filter='', modelStatus='';
function clean(s){return String(s??'').replace(/[\x00-\x1f\x7f]/g,'');}
function strip(s){return String(s).replace(/\x1b\[[0-9;]*m/g,'');}
function fit(s,width){
 let visible=0,out='';const tokens=String(s).match(/\x1b\[[0-9;]*m|[^]/gu)||[];
 for(const token of tokens){if(token.startsWith('\x1b'))out+=token;else{if(visible>=width-1){out+='…';visible++;break;}out+=token;visible++;}}
 return out+' '.repeat(Math.max(0,width-visible));
}
function txt(s,tone='fg'){return C[tone]+clean(s)+C.fg;}
function age(ms){return ms>3600000?`${Math.floor(ms/3600000)}h ${Math.floor(ms%3600000/60000)}m`:`${Math.floor(ms/60000)}m`;}
function items(){
 if(!state)return[];
 const cfg=state.config,names=Object.keys(cfg.upstreams);
 if(section===0)return[
 {label:state.service.running?'Stop proxy':'Start proxy',action:()=>service(state.service.running?'stop':'start')},
 {label:'Restart proxy',action:()=>service('restart')},
 {label:'Open browser dashboard  ↗',action:openBrowser},
 {label:'Refresh status',action:refresh}];
 if(section===1&&detail){const u=cfg.upstreams[detail];if(!u){detail=null;return items();}return[
 {label:`Base URL          ${u.baseUrl}`,action:()=>editField('baseUrl')},
 {label:`API key           ${u.keyConfigured?'Configured (hidden)':'Client passthrough'}`,action:()=>editField('apiKey')},
 {label:`Injected headers  ${Object.keys(u.headers||{}).length+(u.secretHeaders?.length||0)} configured`,action:()=>editField('headers')},
 {label:`SSE null filter   ${u.sanitizeSse===false?'Off':'On'}`,action:()=>saveProvider({sanitizeSse:u.sanitizeSse===false})},
 {label:`Session headers   ${u.injectSessionHeaders?'On':'Off'}`,action:()=>saveProvider({injectSessionHeaders:!u.injectSessionHeaders})},
 {label:`Heartbeat         ${u.heartbeatMs===undefined?'Gateway default':`${u.heartbeatMs}ms`}`,action:()=>editField('heartbeatMs')},
 {label:`Strip body keys   ${(u.stripBodyKeys||[]).join(', ')||'None'}`,action:()=>editField('stripBodyKeys')},
 {label:'Browse model catalog',action:async()=>{catalogProvider=detail;section=3;detail=null;await fetchCatalog();}},
 {label:'Delete provider',action:deleteProvider},
 {label:'Back to providers',action:()=>{detail=null;selected=0;}}];}
 if(section===1)return[...names.map(name=>({label:`${name.padEnd(17)} ${cfg.upstreams[name].keyConfigured?'● Key set  ':'○ No key   '} ${cfg.upstreams[name].baseUrl}${cfg.defaultUpstream===name?'  [default]':''}`,action:()=>{detail=name;selected=0;}})),{label:'+ Add provider',action:addProvider}];
 if(section===2)return(state.metrics?.recent||[]).map(r=>({label:`${new Date(r.at).toLocaleTimeString('en-GB')}  ${String(r.status).padEnd(5)} ${r.method.padEnd(5)} ${r.upstream.padEnd(15)} ${r.endpoint}  ${r.durationMs}ms`}));
 if(section===3){
  if(!catalogProvider)return names.map(name=>({label:`${name}  ·  Fetch model catalog`,action:async()=>{catalogProvider=name;await fetchCatalog();}}));
  return[{label:'← Choose another provider',action:()=>{catalogProvider='';catalog=[];filter='';selected=0;}},
   {label:'↻ Fetch catalog again',action:fetchCatalog},...catalog.filter(m=>m.toLowerCase().includes(filter.toLowerCase())).map(model=>({label:model,action:()=>probe(model)}))];
 }
 return[
 {label:`Default provider     ${cfg.defaultUpstream||'None'}`,action:()=>setting('defaultUpstream','Default route (empty = none)',cfg.defaultUpstream||'')},
 {label:`Proxy port           ${cfg.port||8787}`,action:()=>setting('port','Proxy port',cfg.port||8787)},
 {label:`Stream heartbeat     ${cfg.heartbeatMs||0}ms`,action:()=>setting('heartbeatMs','Heartbeat ms (0 = off)',cfg.heartbeatMs||0)},
 {label:`Max request body     ${cfg.maxBodyBytes||10485760} bytes`,action:()=>setting('maxBodyBytes','Maximum body bytes',cfg.maxBodyBytes||10485760)},
 {label:`Log level            ${cfg.logLevel||'info'}`,action:()=>setting('logLevel','error / warn / info / debug',cfg.logLevel||'info')},
 {label:`Require proxy token  ${cfg.publicMode?'On':'Off'}`,action:async()=>{if(await confirm('Change token requirement? Local keys become usable without a token when off.'))await apply('settings.save',{publicMode:!cfg.publicMode});}},
 {label:'Validate config',action:()=>{loadConfig();notify('Configuration is valid.');}},
 {label:'Open browser dashboard  ↗',action:openBrowser}];
}
function render(){
 if(!interactive||closed)return;
 const w=Math.max(20,process.stdout.columns||80),h=Math.max(8,process.stdout.rows||24);
 if(w<66||h<17){process.stdout.write('\x1b[H\x1b[2J'+fit('UA Proxy · resize terminal to at least 66 × 17',w)+'\r\n'+fit('q / Ctrl+C to quit',w));return;}
 const side=w>=90?23:18,main=w-side-5;
 let info=[];
 if(!state)info=['Connecting to local workspace…'];
 else if(section===0){const m=state.metrics;info=[txt('Your local gateway. Under your control.','muted'),'',
 `${txt(String(m?.total||0),'blue')} requests    ${txt(String(m?.active||0),'green')} active    ${txt(String(m?.errors||0),m?.errors?'red':'muted')} failed`,
 `Providers  ${Object.keys(state.config.upstreams).length}     Uptime  ${m?.startedAt?age(Date.now()-m.startedAt):'—'}`,
 `Endpoint   ${state.endpoint}/v1`,
 `Token      ${state.config.publicMode?'Required':'Not required'}     Heartbeat  ${state.config.heartbeatMs||0}ms`,''];}
 else if(section===1)info=[txt(detail?`Provider / ${detail}`:'Manage routes, headers, and stored credentials.','muted'),txt('Keys stay hidden. Saves apply to a running proxy.','muted'),''];
 else if(section===2)info=[txt('Recent traffic · no request content or credentials retained','muted'),''];
 else if(section===3)info=[txt(catalogProvider?`${catalogProvider}  ·  ${catalog.length} models  ${filter?`· filter: ${filter}`:''}`:'Select a provider to browse its models.','muted'),txt(modelStatus||'Catalog fetch is read-only. Model tests ask before sending.','muted'),''];
 else info=[txt('Gateway preferences · dashboard remains on 127.0.0.1:8788','muted'),txt('A private backup is made for every config save.','muted'),''];
 const list=items();selected=Math.max(0,Math.min(selected,Math.max(0,list.length-1)));
 const capacity=Math.max(1,h-9-info.length);const offset=Math.max(0,Math.min(selected-Math.floor(capacity/2),list.length-capacity));
 const content=[...info];
 if(!list.length)content.push(txt('No requests yet. Your first request will appear here.','muted'));
 list.slice(offset,offset+capacity).forEach((item,i)=>{const active=selected===i+offset&&focus==='content';content.push((active?C.selected+C.blue:C.bg+C.fg)+fit(`${active?' ›':'  '} ${clean(item.label)}`,main)+C.bg+C.fg);});
 const rows=[];rows.push(C.bg+C.fg+fit(`  UA PROXY   /   LOCAL CONTROL${' '.repeat(Math.max(1,w-57))}${state?.service.running?'● Running':'○ Stopped'}`,w));
 rows.push(C.bg+C.muted+fit('  '+'─'.repeat(w-4),w));
 for(let y=0;y<h-7;y++){
  let left='';if(y===0)left=txt('  U  ua-proxy','fg');else if(y===1)left=txt('     Local gateway','muted');
  else if(y>=4&&y<9){const i=y-4;left=(section===i?C.selected+C.blue:C.side+C.muted)+` ${focus==='sidebar'&&section===i?'›':' '} ${i+1}  ${sections[i]}`;}
  else if(y===h-11)left=txt('  ● Loopback only','green');
  const right=y===0?C.bold+sections[section]+(detail?` / ${detail}`:'')+C.reset+C.bg+C.fg:y===1?'':content[y-2]||'';
  rows.push(C.side+fit(left,side)+C.bg+'  '+fit(right,main+2)+C.reset);
 }
 rows.push(C.bg+C.muted+fit('  '+'─'.repeat(w-4),w));
 let status=busy?'Working…':message||'Ready.  Open the browser dashboard for charts and full forms.';
 if(prompt)status=`${prompt.question}: ${prompt.secret?'•'.repeat(prompt.value.length):prompt.value}${prompt.kind==='confirm'?' [y/N]':''}`;
 rows.push(C.bg+(error?C.red:C.blue)+fit('  '+clean(status),w)+C.reset);
 rows.push(C.bg+C.muted+fit('  ↑↓ / jk move   Enter select   Tab focus   1–5 pages   Esc back   / search   q quit',w)+C.reset);
 rows.push(C.bg+C.muted+fit(`  ${state?.dashboard||'http://127.0.0.1:8788'}   ·   ${list.length?`${selected+1}/${list.length}`:'0 items'}${offset?'   ↑ more':''}${offset+capacity<list.length?'   ↓ more':''}`,w)+C.reset);
 process.stdout.write('\x1b[H'+rows.join('\r\n')+'\x1b[J\x1b[?25l');
}
function notify(text,isError=false){message=clean(text);error=isError;render();}
async function refresh(){state=await snapshot();render();}
function ask(question,initial='',secret=false){return new Promise(resolve=>{prompt={question,value:String(initial??''),secret,resolve};render();});}
async function confirm(question){return new Promise(resolve=>{prompt={question,value:'',kind:'confirm',resolve};render();});}
function finishPrompt(value){const resolve=prompt.resolve;prompt=null;resolve(value);render();}
async function apply(action,input){const r=await perform(action,input);await refresh();notify(r.message||'Done.');return r;}
async function service(action){if(action!=='start'&&!await confirm(`${action==='stop'?'Stop':'Restart'} proxy? Active requests may be interrupted.`))return;await apply(action);}
function openBrowser(){const child=spawn('/usr/local/bin/google-chrome',['http://127.0.0.1:8788'],{detached:true,stdio:'ignore'});child.on('error',()=>notify('Open http://127.0.0.1:8788 in your VPS browser.',true));child.unref();notify('Opened the local dashboard in your VPS browser.');}
async function saveProvider(changes){const u=state.config.upstreams[detail];return apply('provider.save',{name:detail,...u,...changes});}
async function editField(field){
 const u=state.config.upstreams[detail];let initial=u[field]??'';let q=field;
 if(field==='apiKey'){initial='';q='New API key (Esc cancels, empty keeps current)';}
 if(field==='headers'){initial=JSON.stringify(u.headers||{});q='Injected headers (JSON)';}
 if(field==='stripBodyKeys'){initial=(u.stripBodyKeys||[]).join(', ');q='Body fields to strip (comma separated)';}
 const value=await ask(q,initial,field==='apiKey');if(value===null)return;
 let parsed=value;if(field==='headers')parsed=JSON.parse(value||'{}');if(field==='stripBodyKeys')parsed=value.split(',').map(s=>s.trim()).filter(Boolean);
 await saveProvider({[field]:parsed});
}
async function addProvider(){
 const name=await ask('Route name');if(!name)return;
 if(Object.hasOwn(state.config.upstreams,name))throw new Error('That route already exists; edit it instead.');
 const baseUrl=await ask('Base URL (https://…/v1)');if(!baseUrl)return;
 const apiKey=await ask('API key (empty = client passthrough)','',true);if(apiKey===null)return;
 const agent=await ask('User-Agent header (optional)');if(agent===null)return;
 await apply('provider.save',{name,baseUrl,apiKey,headers:agent?{'user-agent':agent}:{},sanitizeSse:true});
}
async function deleteProvider(){const name=detail;if(await confirm(`Delete provider ${name}?`)){await apply('provider.delete',{name});detail=null;selected=0;}}
async function setting(field,label,initial){const value=await ask(label,initial);if(value===null)return;await apply('settings.save',{[field]:value});}
async function fetchCatalog(){const result=await perform('models',{name:catalogProvider});catalog=result.models;selected=0;filter='';modelStatus=`${result.status||'Network error'} · ${result.latencyMs}ms · ${result.kind}`;notify(result.ok?`${catalog.length} models loaded.`:result.message,!result.ok);}
async function probe(model){if(!await confirm(`Send 24-token test to ${model}? May use provider credits.`))return;const r=await perform('test',{name:catalogProvider,model});notify(`${model}: ${r.status||r.kind} · ${r.latencyMs}ms · ${r.ok?r.reply:r.message}`,!r.ok);}
async function handleKey(str,key={}){
 if(key.ctrl&&key.name==='c')return quit();
 if(prompt){
  if(key.name==='escape')return finishPrompt(prompt.kind==='confirm'?false:null);
  if(prompt.kind==='confirm'){if(key.name==='y')finishPrompt(true);else if(['n','return','enter'].includes(key.name))finishPrompt(false);return;}
  if(['return','enter'].includes(key.name))return finishPrompt(prompt.value.trim());
  if(key.name==='backspace'){prompt.value=prompt.value.slice(0,-1);render();return;}
  if(key.ctrl&&key.name==='u'){prompt.value='';render();return;}
  if(!key.ctrl&&!key.meta&&str&&!str.includes('\x1b')){prompt.value+=clean(str);render();}return;
 }
 if(key.name==='q')return quit();if(busy)return;
 if(/^[1-5]$/.test(str)){section=Number(str)-1;detail=null;selected=0;focus='content';render();return;}
 if(key.name==='tab'||key.name==='left'){focus=focus==='sidebar'?'content':'sidebar';render();return;}
 if(key.name==='right'){focus='content';render();return;}
 if(key.name==='escape'||key.name==='backspace'){if(detail){detail=null;selected=0;}else if(section===3&&catalogProvider){catalogProvider='';catalog=[];selected=0;filter='';}else focus='sidebar';render();return;}
 const list=items();
 if(['up','down','j','k','home','end','pageup','pagedown'].includes(key.name)){
  if(focus==='sidebar'){section=(section+(['up','k'].includes(key.name)?4:1))%5;selected=0;detail=null;}
  else if(key.name==='home')selected=0;else if(key.name==='end')selected=Math.max(0,list.length-1);
  else selected=Math.max(0,Math.min(Math.max(0,list.length-1),selected+(['up','k'].includes(key.name)?-1:key.name==='pageup'?-10:key.name==='pagedown'?10:1)));
  render();return;
 }
 let fn;
 if(str==='/'&&section===3&&catalogProvider)fn=async()=>{const value=await ask('Filter model names',filter);if(value!==null){filter=value;selected=0;}};
 else if(key.name==='r')fn=refresh;
 else if(key.name==='b')fn=openBrowser;
 else if(['return','enter'].includes(key.name)){if(focus==='sidebar'){focus='content';render();return;}fn=list[selected]?.action;}
 if(fn){busy=true;render();try{await fn();}catch(e){notify(sanitize(e.message),true);}finally{busy=false;render();}}
}
function quit(code=0){if(closed)return;closed=true;clearInterval(timer);process.stdin.setRawMode?.(false);process.stdout.write('\x1b[0m\x1b[?25h\x1b[?1049l');process.exit(code);}
async function main(){
 if(!interactive){console.log('Run uaproxy tui from an interactive terminal. Dashboard: http://127.0.0.1:8788');return;}
 process.stdout.write('\x1b[?1049h\x1b[?25l');readline.emitKeypressEvents(process.stdin,{escapeCodeTimeout:100});process.stdin.setRawMode(true);
 process.stdin.on('keypress',(str,key)=>void handleKey(str,key));process.stdout.on('resize',render);
 for(const sig of ['SIGINT','SIGTERM','SIGHUP','SIGQUIT'])process.on(sig,()=>quit());
 process.on('uncaughtException',e=>{notify(e.message,true);quit(1);});process.on('unhandledRejection',e=>{notify(e.message,true);quit(1);});
 try{await refresh();}catch(e){notify(e.message,true);}
 timer=setInterval(()=>{if(!busy&&!prompt)refresh().catch(e=>notify(e.message,true));},3000);render();
}
if(require.main===module)main();
module.exports={fit,strip};

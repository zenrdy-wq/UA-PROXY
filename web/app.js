'use strict';
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = v => String(v ?? '').replace(/[&<>"']/g,c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const pages = ['overview','providers','activity','models','settings','playground'];
const titles = {overview:'Overview',providers:'Channels',activity:'Activity',models:'Model explorer',settings:'Settings',playground:'Playground'};
let csrf, state, page='overview', settingsDirty=false, busy=false, catalog=[], catalogName='', toastTimer, pollTimer;
const nf = new Intl.NumberFormat('en-US');
function toast(message,error=false) { const t=$('#toast');t.textContent=message;t.classList.toggle('error',error);t.hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>t.hidden=true,5500); }
async function request(url, options={}) {
 const res=await fetch(url,{credentials:'same-origin',...options});
 const data=await res.json();if(!res.ok)throw new Error(data.error||`HTTP ${res.status}`);return data;
}
async function initSession(){csrf=(await request('/api/session')).csrf;}
async function action(name,input={}) {
 return request('/api/action',{method:'POST',headers:{'content-type':'application/json','x-csrf-token':csrf},body:JSON.stringify({action:name,input})});
}
async function run(button,fn) {
 if(busy)return;
 busy=true;const label=button?.textContent;if(button){button.disabled=true;button.textContent='Working…';}
 try{await fn();await refresh();}catch(e){toast(e.message,true);}finally{busy=false;if(button){button.disabled=false;button.textContent=label;}renderService();window.renderCredentials?.();}
}
function navigate(){
 const next=location.hash.slice(1)==='channels'?'providers':location.hash.slice(1);page=pages.includes(next)?next:'overview';
 pages.forEach(p=>{$(`#page-${p}`).hidden=p!==page;});
 $$('nav a').forEach(a=>{a.classList.toggle('active',a.dataset.page===page);if(a.dataset.page===page)a.setAttribute('aria-current','page');else a.removeAttribute('aria-current');});
 $('#breadcrumb').textContent=titles[page];$('.sidebar').classList.remove('open');document.title=`${titles[page]} · UA Proxy`;
 window.hideSecrets?.();
 if(page==='activity'&&window.refreshHistory)window.refreshHistory();
}
function duration(ms){return ms>=1000?`${(ms/1000).toFixed(1)}s`:`${Math.round(ms)}ms`;}
function uptime(ms){if(ms<60000)return'Just started';if(ms<3600000)return`${Math.floor(ms/60000)}m uptime`;return`${Math.floor(ms/3600000)}h ${Math.floor(ms%3600000/60000)}m uptime`;}
function renderService(){
 if(!state)return;
 const live=state.service.running;
 const el=$('#service-status');el.className=`status-pill ${live?'running':'stopped'}`;
 el.innerHTML=`<span class="dot ${live?'green':'muted'}"></span>${live?'Proxy running':'Proxy stopped'}`;
 const button=$('#overview-toggle');button.textContent=live?'Stop proxy':'Start proxy';button.disabled=busy;
 $('#restart-proxy').disabled=busy||!live;
 const m=state.metrics;
 $('#footer-status').textContent=m?.startedAt?`${uptime(Date.now()-m.startedAt)} · ${m.active} active`:(live?'Collecting session metrics…':'Proxy is stopped');
}
function renderStats(){
 const m=state.metrics;const total=m?.total||0;
 $('#stat-requests').textContent=nf.format(total);
 $('#stat-success').innerHTML=total?`${((1-(m.errors/total))*100).toFixed(1)}<em>%</em>`:'—<em>%</em>';
 $('#stat-latency').innerHTML=total?`${esc(duration(m.durationMs/total))}`:'—';
 $('#stat-errors').textContent=total?`${nf.format(m.errors)} failed · ${nf.format(total-m.errors)} successful`:'Waiting for requests';
 const names=Object.keys(state.config.upstreams);
 $('#stat-providers').textContent=names.length;
 $('#stat-provider-caption').textContent=`${Object.values(state.config.upstreams).filter(u=>u.keyConfigured).length} with stored credentials`;
 $('#provider-count').textContent=names.length;
 $('#endpoint-code').textContent=`${state.publicEndpoint||state.endpoint}/v1`;
 $('#connection-scope').textContent=state.publicEndpoint?'Public · Tailscale Funnel':'Loopback only';
 $('.loopback').lastChild.textContent=state.publicEndpoint?'Funnel ready':'127.0.0.1';
 $('#auth-caption').textContent=state.config.accessRevoked?'Access revoked':(state.publicEndpoint||state.config.publicMode)?'Token protected':'Client auth passthrough';
 window.renderCredentials?.();
 const minute=Math.floor(Date.now()/60000)*60000;
 const points=Array.from({length:30},(_,i)=>state.metrics?.buckets.find(b=>b.at===minute-(29-i)*60000)||{count:0,errors:0});
 const max=Math.max(1,...points.map(p=>p.count));
 const chart=$('#traffic-chart');chart.replaceChildren();
 points.forEach((p,i)=>{const bar=document.createElement('div');bar.className='chart-bar';bar.title=`${29-i} min ago: ${p.count} requests, ${p.errors} errors`;const total=document.createElement('div');total.className='bar-total';total.style.height=`${(p.count-p.errors)/max*100}%`;const error=document.createElement('div');error.className='bar-error';error.style.height=`${p.errors/max*100}%`;bar.append(error,total);chart.append(bar);});
 const sum=points.reduce((a,b)=>a+b.count,0);$('#chart-total').textContent=`${nf.format(sum)} requests`;
 if(!sum){const empty=document.createElement('div');empty.className='chart-empty';empty.innerHTML='<span>Ready when you are.</span><small>Your first request will appear here.</small>';chart.append(empty);}
}
function table(rows){
 if(!rows.length)return'<div class="empty"><span>⌁</span><h3>Nothing passing through. Yet.</h3><p>Requests to your local proxy will show up here.</p></div>';
 return`<div class="table-scroll"><table><thead><tr><th>REQUEST</th><th>PROVIDER</th><th>STATUS</th><th>DURATION</th><th>TIME</th><th></th></tr></thead><tbody>${rows.map(r=>`<tr><td><span class="method">${esc(r.method)}</span><span class="path">${esc(r.endpoint)}</span></td><td>${esc(r.upstream)}</td><td><span class="code ${r.status>=400?'fail':''}">${esc(r.status)}</span></td><td>${esc(duration(r.durationMs))}</td><td>${esc(new Date(r.at).toLocaleTimeString('en-GB',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',second:'2-digit'}))}</td><td>${r.id?`<button class="inspect-request" data-request-id="${esc(r.id)}" aria-label="Inspect request ${esc(r.status)}">Inspect ↗</button>`:''}</td></tr>`).join('')}</tbody></table></div>`;
}
function renderActivity(){const rows=state.metrics?.recent||[];$('#recent-requests').innerHTML=table(rows.slice(0,5));if(page==='activity'&&window.refreshHistory)window.refreshHistory();}
let providerSignature='';
function renderProviders(force=false){
 const signature=JSON.stringify(state.config)+$('#provider-search').value;
 if(!force&&signature===providerSignature)return;providerSignature=signature;window.hideSecrets?.('provider');
 const all=Object.entries(state.config.upstreams);const filter=$('#provider-search').value.toLowerCase();
 const matches=all.filter(([name,u])=>`${name} ${u.baseUrl}`.toLowerCase().includes(filter));
 $('#providers-summary').textContent=`${all.length} channels · ${all.filter(([,u])=>u.enabled!==false).length} enabled · ${all.filter(([,u])=>u.keyConfigured).length} with API keys`;
 const grid=$('#provider-grid');grid.innerHTML=matches.length?matches.map(([name,u])=>`<article class="provider-card"><div class="provider-top"><span class="provider-icon">${esc(name[0].toUpperCase())}</span><h2 class="provider-title">${esc(name)}</h2>${u.enabled===false?'<span class="segment channel-disabled">Disabled</span>':state.config.defaultUpstream===name?'<span class="segment">Default</span>':''}</div><p class="provider-url" title="${esc(u.baseUrl)}">${esc(u.baseUrl)}</p><div class="provider-details"><div><span>Credentials</span><strong><span class="dot ${u.keyConfigured?'green':'muted'}"></span>${u.keyConfigured?'Configured':'No stored key'}</strong></div><div><span>Injected headers</span><strong>${Object.keys(u.headers||{}).length+(u.secretHeaders?.length||0)} headers</strong></div><div><span>Stream keep-alive</span><strong>${u.heartbeatMs===0?'Off':`${(u.heartbeatMs??state.config.heartbeatMs??0)/1000}s`}</strong></div></div><div class="channel-key" data-channel-key="${esc(name)}"></div><div class="provider-actions"><button class="button edit-provider" data-name="${esc(name)}">Edit channel</button><button class="button browse-provider" data-name="${esc(name)}">Browse models ↗</button></div></article>`).join(''):'<div class="empty"><h3>No matching channels.</h3><p>Try another name or URL.</p></div>';
 window.mountChannelCredentials?.();
 $$('.edit-provider').forEach(b=>b.onclick=()=>openProvider(b.dataset.name));
 $$('.browse-provider').forEach(b=>b.onclick=()=>{location.hash='models';$('#model-provider').value=b.dataset.name;clearCatalog();loadCatalog();});
}
function populateSettings(){
 const cfg=state.config;
 if(!settingsDirty){const form=$('#settings-form');['port','heartbeatMs','maxBodyBytes','logLevel'].forEach(k=>form.elements[k].value=cfg[k]??(k==='heartbeatMs'?0:''));form.elements.publicMode.checked=cfg.publicMode;}
 const names=Object.keys(cfg.upstreams);const modelSelect=$('#model-provider');const modelValue=modelSelect.value;
 if([...modelSelect.options].map(o=>o.value).join()!==names.join()){modelSelect.innerHTML=names.map(n=>`<option>${esc(n)}</option>`).join('');modelSelect.value=names.includes(modelValue)?modelValue:cfg.defaultUpstream||names[0];}
 const defaultSelect=$('#default-provider');if(!settingsDirty){defaultSelect.innerHTML='<option value="">No default (explicit routes only)</option>'+names.map(n=>`<option>${esc(n)}</option>`).join('');defaultSelect.value=cfg.defaultUpstream||'';}
}
async function refresh(){
 try{state=await request('/api/state');$('#connection-error').hidden=true;renderService();renderStats();renderProviders();renderActivity();populateSettings();window.renderCredentials?.();if(window.populateFeatures)window.populateFeatures();}
 catch(e){$('#connection-error').hidden=false;if(/session/.test(e.message))await initSession().catch(()=>{});}
}
function openProvider(name){
 const form=$('#provider-form');form.reset();$('#provider-error').textContent='';const u=name?state.config.upstreams[name]:null;
 $('#provider-dialog-title').textContent=name?`Edit ${name}`:'Add channel';form.elements.name.value=name||'';form.elements.name.readOnly=!!name;
 form.elements.baseUrl.value=u?.baseUrl||'';form.elements.apiKey.value='';form.elements.apiKey.placeholder=u?.keyConfigured?'Leave blank to keep stored key':'Paste a key';
 $('#key-help').textContent=u?.keyConfigured?'A key is configured. Leave blank to keep it, or enter a replacement.':'Paste the API key issued by this provider.';
 form.elements.enabled.checked=u?.enabled!==false;
 window.mountProviderCredential?.(name,u);
 form.elements.headers.value=JSON.stringify(u?.headers||{},null,2);form.elements.stripBodyKeys.value=(u?.stripBodyKeys||[]).join(', ');form.elements.heartbeatMs.value=u?.heartbeatMs??'';
 form.elements.sanitizeSse.checked=u?.sanitizeSse!==false;form.elements.injectSessionHeaders.checked=u?.injectSessionHeaders===true;form.elements.chatVia.value=u?.chatVia||'';
 $('#delete-provider').hidden=!name;$('#delete-provider').disabled=name===state.config.defaultUpstream;$('#delete-provider').title=name===state.config.defaultUpstream?'Choose another default in Settings first':'';
 form.querySelector('details').open=false;$('#provider-dialog').showModal();
}
function confirmAction(title,message,yes='Continue'){
 return new Promise(resolve=>{const dialog=$('#confirm-dialog');$('#confirm-title').textContent=title;$('#confirm-message').textContent=message;$('#confirm-yes').textContent=yes;
 const finish=value=>{dialog.close();resolve(value);};$('#confirm-yes').onclick=()=>finish(true);$('#confirm-cancel').onclick=()=>finish(false);dialog.oncancel=()=>resolve(false);dialog.showModal();});
}
function clearCatalog(){catalog=[];catalogName='';$('#model-list').innerHTML='<div class="empty"><span>◇</span><h3>A world of models, one click away.</h3><p>Fetch this provider’s catalog to get started.</p></div>';$('#model-count').textContent='';$('#catalog-status').textContent='Catalogs load only when you ask.';$('#model-result').hidden=true;}
function renderModels(){const filter=$('#model-search').value.toLowerCase();const shown=catalog.filter(m=>m.toLowerCase().includes(filter));$('#model-count').textContent=`${shown.length} of ${catalog.length} models`;const list=$('#model-list');list.replaceChildren();if(!shown.length){list.innerHTML='<div class="empty"><h3>No models to show.</h3><p>Try a different search or provider.</p></div>';return;}shown.forEach(model=>{const row=document.createElement('div');row.className='model-row';const title=document.createElement('span');title.textContent=model;const b=document.createElement('button');b.className='button';b.textContent='Test model ↗';b.onclick=async()=>{if(!await confirmAction('Send a small test?',`This sends “Reply exactly: OK” to ${model} on ${catalogName}, with a 24-token output limit. It may use provider credits.`,'Send test'))return;run(b,async()=>{const result=await action('test',{name:catalogName,model});const box=$('#model-result');box.hidden=false;box.textContent=`${model} · ${result.status||'Network error'} · ${duration(result.latencyMs)} — ${result.ok?result.reply:result.message}`;toast(result.ok?'Model responded.':result.message,!result.ok);});};row.append(title,b);list.append(row);});}
async function loadCatalog(){await run($('#load-models'),async()=>{const name=$('#model-provider').value;const result=await action('models',{name});catalogName=name;catalog=result.models;$('#catalog-status').textContent=`${result.status||'Network error'} · ${duration(result.latencyMs)} · ${result.kind}`;renderModels();if(!result.ok)toast(result.message,true);});}
$('#overview-toggle').onclick=()=>run($('#overview-toggle'),async()=>{const op=state.service.running?'stop':'start';if(op==='stop'&&!await confirmAction('Stop the proxy?','Active requests may be interrupted. The dashboard will stay available.','Stop proxy'))return;const r=await action(op);toast(r.message);});
$('#restart-proxy').onclick=()=>run($('#restart-proxy'),async()=>{if(!await confirmAction('Restart the proxy?','Active requests may be interrupted. Your saved config and credentials will be kept.','Restart'))return;toast((await action('restart')).message);});
$('#copy-endpoint').onclick=async()=>{try{await navigator.clipboard.writeText($('#endpoint-code').textContent);toast('Endpoint copied.');}catch{toast('Select and copy the endpoint text.');}};
$('#provider-search').oninput=()=>state&&renderProviders(true);$('#model-search').oninput=renderModels;
$('#add-provider').onclick=()=>openProvider();$$('.close-dialog').forEach(b=>b.onclick=()=>$('#provider-dialog').close());
$('#provider-form').onsubmit=async e=>{e.preventDefault();const form=e.currentTarget;const button=form.querySelector('[type=submit]');
 try{if(!form.elements.name.readOnly&&Object.hasOwn(state.config.upstreams,form.elements.name.value))throw new Error('That channel already exists. Use Edit channel to update it.');const headers=JSON.parse(form.elements.headers.value||'{}');const input={name:form.elements.name.value,baseUrl:form.elements.baseUrl.value,apiKey:form.elements.apiKey.value,clearKey:form.elements.clearKey.checked,enabled:form.elements.enabled.checked,headers,stripBodyKeys:form.elements.stripBodyKeys.value.split(',').map(s=>s.trim()).filter(Boolean),heartbeatMs:form.elements.heartbeatMs.value,sanitizeSse:form.elements.sanitizeSse.checked,injectSessionHeaders:form.elements.injectSessionHeaders.checked,chatVia:form.elements.chatVia.value};await run(button,async()=>{try{const r=await action('provider.save',input);form.elements.apiKey.value='';$('#provider-dialog').close();toast(r.message);}catch(error){$('#provider-error').textContent=error.message;throw error;}});}catch(error){$('#provider-error').textContent=error.message;}
};
$('#delete-provider').onclick=async()=>{const name=$('#provider-form').elements.name.value;if(!await confirmAction(`Delete ${name}?`,'This removes the route and its stored credential. A private config backup is retained.','Delete channel'))return;await run($('#delete-provider'),async()=>{toast((await action('provider.delete',{name})).message);$('#provider-dialog').close();});};
$('#settings-form').oninput=()=>settingsDirty=true;
$('#settings-form').onsubmit=async e=>{e.preventDefault();const form=e.currentTarget;const input=Object.fromEntries(new FormData(form));input.publicMode=form.elements.publicMode.checked;if(!input.publicMode&&state.config.publicMode&&!await confirmAction('Turn off the proxy token?','Local clients will be able to use the stored provider keys without a proxy token. The listener will remain loopback-only.','Turn off'))return;await run(form.querySelector('[type=submit]'),async()=>{const r=await action('settings.save',input);settingsDirty=false;toast(r.message);});};
$('#load-models').onclick=loadCatalog;$('#model-provider').onchange=clearCatalog;
$('#mobile-menu').onclick=()=>$('.sidebar').classList.toggle('open');
window.addEventListener('hashchange',navigate);
window.addEventListener('keydown',e=>{if(e.key==='Escape')$('.sidebar').classList.remove('open');if(e.ctrlKey||e.metaKey||e.altKey||e.target.matches('input,textarea,select')||$('dialog[open]'))return;if(pages[Number(e.key)-1])location.hash=pages[Number(e.key)-1];if(e.key==='/'){const search=$(`#page-${page} input[type=search]`);if(search){e.preventDefault();search.focus();}}});
document.addEventListener('visibilitychange',()=>{if(!document.hidden)refresh();});
async function poll(){await refresh();pollTimer=setTimeout(poll,document.hidden?10000:2500);}
(async()=>{navigate();try{await initSession();await poll();}catch(error){$('#connection-error').hidden=false;toast(error.message,true);setTimeout(()=>location.reload(),5000);}})();

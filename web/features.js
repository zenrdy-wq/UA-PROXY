'use strict';
let historyPage=1,historySequence=0,historyTimer,selectedRequestId='';
window.refreshHistory=async function(){
 if(!csrf)return;const sequence=++historySequence;
 const query=new URLSearchParams({range:$('#history-range').value,provider:$('#history-provider').value,status:$('#history-status').value,q:$('#activity-search').value,page:historyPage,limit:25});
 try{
  const data=await request('/api/history?'+query);if(sequence!==historySequence)return;
  historyPage=data.page;$('#activity-requests').innerHTML=table(data.rows);$('#history-page-label').textContent=`Page ${data.page} of ${data.pages}`;
  $('#history-prev').disabled=data.page<=1;$('#history-next').disabled=data.page>=data.pages;
  $('#history-summary').textContent=`${nf.format(data.total)} requests · ${nf.format(data.errors)} failed${data.total?` · ${duration(data.durationMs/data.total)} average`:''}`;
 }catch(e){if(sequence===historySequence)$('#history-summary').textContent=e.message;}
};
function historyFilterChanged(){historyPage=1;clearTimeout(historyTimer);historyTimer=setTimeout(window.refreshHistory,180);}
$('#activity-search').oninput=historyFilterChanged;
['#history-range','#history-provider','#history-status'].forEach(id=>$(id).onchange=historyFilterChanged);
$('#history-prev').onclick=()=>{historyPage=Math.max(1,historyPage-1);window.refreshHistory();};$('#history-next').onclick=()=>{historyPage++;window.refreshHistory();};
async function inspectRequest(id){
 try{
 const row=await request('/api/request?'+new URLSearchParams({id}));selectedRequestId=row.id;
 const d=row.diagnosis;$('#request-title').textContent=d?.message||(row.status>=400?'Request failed':'Request completed');
 const fields=[['Request ID',row.id],['Provider',row.upstream],['Endpoint',`${row.method} ${row.endpoint}`],['HTTP / outcome',`${row.status}${row.upstreamStatus&&row.upstreamStatus!==row.status?` (upstream HTTP ${row.upstreamStatus})`:''}`],['Full duration',duration(row.durationMs)],['Time',new Date(row.at).toLocaleString()],['Origin',row.origin==='playground'?'Playground':row.origin==='legacy'?'Imported history':'Proxy client'],['Error source',d?.source||'—'],['Provider error code',d?.code||'—']];
 $('#request-detail').innerHTML=`<dl class="request-meta">${fields.map(([k,v])=>`<div><dt>${esc(k)}</dt><dd class="${k==='Request ID'?'request-id':''}">${esc(v)}</dd></div>`).join('')}</dl>${d?`<div class="diagnosis"><h3>${esc(d.message)}</h3><p>${esc(d.hint)}</p></div>`:'<div class="diagnosis success"><h3>Delivered through your gateway.</h3><p>No HTTP or structured stream error was observed for this request.</p></div>'}<p class="detail-note">Only request metadata and a classified diagnosis are retained. Raw provider errors, prompts, credentials, and response content are not saved. Status 499 means the connection ended before a full response was delivered.</p>`;
 $('#request-dialog').showModal();
 }catch(e){toast(e.message,true);}
}
document.addEventListener('click',e=>{const b=e.target.closest('[data-request-id]');if(b)inspectRequest(b.dataset.requestId);});
$('#close-request').onclick=$('#request-done').onclick=()=>$('#request-dialog').close();
$('#copy-request-id').onclick=async()=>{try{await navigator.clipboard.writeText(selectedRequestId);toast('Request ID copied.');}catch{toast('Select the request ID to copy it.');}};
window.populateFeatures=function(){
 if(!state)return;
 const names=Object.keys(state.config.upstreams);
 for(const selector of ['#history-provider','#pg-provider']){
  const el=$(selector),prior=el.value;const withAll=selector==='#history-provider';
  const signature=names.join('|');if(el.dataset.options===signature)continue;
  el.innerHTML=(withAll?'<option value="">All providers</option>':'')+names.map(n=>`<option>${esc(n)}</option>`).join('');
  el.value=names.includes(prior)?prior:withAll?'':state.config.defaultUpstream||names[0];el.dataset.options=signature;
 }
};
let pgConversation=[],pgController=null,pgCatalog=[],pgGenerating=false,pgBoundModel='',pgBoundProvider='';
function resetChat(){
 pgConversation=[];$('#pg-chat').innerHTML='<div class="empty"><span>✧</span><h3>A little room to experiment.</h3><p>Pick a provider and model, then write your first message.</p></div>';
 $('#pg-generation-meta').textContent='Ready · No automatic retries';$('#pg-generation-meta').classList.remove('error');
 $('#pg-session-caption').textContent='Chat is kept only in this tab.';pgBoundModel='';pgBoundProvider='';
}
function setGenerating(value){
 pgGenerating=value;$('#pg-send').disabled=value;$('#pg-stop').hidden=!value;$('#pg-clear').disabled=value;$('#pg-prompt').disabled=value;
 $$('.playground-controls input,.playground-controls select,.playground-controls textarea,.playground-controls button').forEach(el=>el.disabled=value);
}
function addBubble(role,content=''){
 const chat=$('#pg-chat');chat.querySelector('.empty')?.remove();const turn=document.createElement('article');turn.className=`chat-turn ${role}`;
 const head=document.createElement('div');head.className='chat-role';const name=document.createElement('span');name.textContent=role==='user'?'You':$('#pg-model').value||'Assistant';head.append(name);
 const copy=document.createElement('button');copy.type='button';copy.textContent='Copy';copy.onclick=async()=>{try{await navigator.clipboard.writeText(body.textContent);toast('Message copied.');}catch{toast('Select the message to copy it.');}};head.append(copy);
 const body=document.createElement('div');body.className='chat-bubble';body.textContent=content;turn.append(head,body);chat.append(turn);
 return{turn,body};
}
function chatScroll(){const el=$('#pg-chat');el.scrollTop=el.scrollHeight;}
$('#pg-load-models').onclick=async()=>{
 const b=$('#pg-load-models');b.disabled=true;b.textContent='Loading catalog…';
 try{const provider=$('#pg-provider').value;const result=await action('models',{name:provider});pgCatalog=result.models;
 $('#pg-model-list').replaceChildren(...pgCatalog.map(m=>{const o=document.createElement('option');o.value=m;return o;}));
 $('#pg-catalog-status').textContent=result.ok?`${pgCatalog.length} models · Type to search the Model ID field.`:result.message;
 if(!$('#pg-model').value&&pgCatalog.length)$('#pg-model').value=pgCatalog[0];
 }catch(e){toast(e.message,true);}finally{b.disabled=pgGenerating;b.textContent='Browse provider models ↗';}
};
$('#pg-provider').onchange=()=>{resetChat();$('#pg-model').value='';$('#pg-model-list').replaceChildren();pgCatalog=[];$('#pg-catalog-status').textContent='Enter an ID, or fetch a catalog.';};
$('#pg-clear').onclick=()=>{if(!pgGenerating){resetChat();$('#pg-prompt').value='';$('#pg-prompt').focus();}};
$('#pg-stop').onclick=()=>pgController?.abort();
$('#pg-prompt').onkeydown=e=>{if((e.ctrlKey||e.metaKey)&&e.key==='Enter'){e.preventDefault();$('#pg-form').requestSubmit();}};
$('#pg-form').onsubmit=async e=>{
 e.preventDefault();if(pgGenerating)return;
 const provider=$('#pg-provider').value,model=$('#pg-model').value.trim(),prompt=$('#pg-prompt').value.trim();
 if(!provider||!model||!prompt){toast('Choose a provider, enter a model ID, and write a message.',true);return;}
 const maxTokens=Number($('#pg-max-tokens').value),temperature=Number($('#pg-temperature').value);
 if(!Number.isInteger(maxTokens)||maxTokens<1||maxTokens>8192||!Number.isFinite(temperature)||temperature<0||temperature>2){toast('Check the output limit (1–8192) and temperature (0–2).',true);return;}
 if(pgConversation.length&&(pgBoundProvider!==provider||pgBoundModel!==model))resetChat();
 const system=$('#pg-system').value.trim();const messages=[...(system?[{role:'system',content:system}]:[]),...pgConversation,{role:'user',content:prompt}];
 if(messages.length>40||messages.reduce((n,m)=>n+m.content.length,0)>32000){toast('This chat reached its context limit. Start a new chat or shorten the prompt.',true);return;}
 pgBoundModel=model;pgBoundProvider=provider;addBubble('user',prompt);const assistant=addBubble('assistant');chatScroll();
 const began=performance.now();let firstToken=null,output='',thinking='',requestId=null,completed=false,failed=false,reasoningBox;
 setGenerating(true);pgController=new AbortController();$('#pg-generation-meta').classList.remove('error');$('#pg-generation-meta').textContent='Connecting through your local proxy…';
 function event(data){
  if(data.type==='meta'){requestId=data.requestId;$('#pg-generation-meta').textContent=`HTTP ${data.status} · ${data.stream?'Streaming':'JSON response'}${requestId?' · '+requestId.slice(0,8):''}`;}
  if(data.type==='delta'||data.type==='reasoning'){
   if(firstToken===null)firstToken=performance.now()-began;
   if(data.type==='delta'){output+=data.text;assistant.body.textContent=output;}else{thinking+=data.text;if(!reasoningBox){const details=document.createElement('details');details.className='reasoning';const summary=document.createElement('summary');summary.textContent='Thinking';reasoningBox=document.createElement('pre');details.append(summary,reasoningBox);assistant.turn.append(details);}reasoningBox.textContent=thinking;}
   $('#pg-generation-meta').textContent=`Generating · ${duration(performance.now()-began)} · first output ${duration(firstToken)}`;chatScroll();
  }
  if(data.type==='error'){failed=true;assistant.body.classList.add('failed');if(!output)assistant.body.textContent=data.message||'Generation failed.';$('#pg-generation-meta').classList.add('error');$('#pg-generation-meta').textContent=`${data.message||'Generation failed.'} ${data.hint||''}${requestId?' · Request '+requestId.slice(0,8):''}`;}
  if(data.type==='done'){completed=true;const tokens=data.usage?` · ${data.usage.input} in / ${data.usage.output} out tokens`:'';$('#pg-generation-meta').textContent=`Done in ${duration(performance.now()-began)}${firstToken===null?'':` · first output ${duration(firstToken)}`}${tokens}${data.finishReason?' · '+data.finishReason:''}`;if(!output)assistant.body.textContent=thinking?'The model returned thinking without a text answer.':'No text answer was returned.';}
 }
 try{
  const response=await fetch('/api/playground',{method:'POST',credentials:'same-origin',signal:pgController.signal,headers:{'content-type':'application/json','x-csrf-token':csrf},body:JSON.stringify({provider,model,messages,maxTokens,temperature,stream:$('#pg-stream').checked})});
  if(!response.ok){let data;try{data=await response.json();}catch{}throw new Error(data?.error||`HTTP ${response.status}`);}
  const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='';
  for(;;){const chunk=await reader.read();if(chunk.done)break;buffer+=decoder.decode(chunk.value,{stream:true});let index;while((index=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,index);buffer=buffer.slice(index+1);if(line.trim())event(JSON.parse(line));}}
  buffer+=decoder.decode();if(buffer.trim())event(JSON.parse(buffer));
  if(!completed&&!failed)throw new Error('The connection ended before generation finished. Partial output was kept.');
  if(completed&&!failed){pgConversation.push({role:'user',content:prompt},{role:'assistant',content:output});$('#pg-prompt').value='';$('#pg-session-caption').textContent=`${pgConversation.length/2} ${pgConversation.length===2?'turn':'turns'} · ${provider} / ${model}`;}
 }catch(error){
  failed=true;assistant.body.classList.add('failed');const stopped=pgController.signal.aborted;
  if(!output)assistant.body.textContent=stopped?'Generation stopped.':error.message;
  $('#pg-generation-meta').classList.add('error');$('#pg-generation-meta').textContent=stopped?'Stopped · Partial output kept here; this turn was not added to the next request.':error.message;
 }finally{pgController=null;setGenerating(false);chatScroll();refresh();if(page==='activity')window.refreshHistory();}
};

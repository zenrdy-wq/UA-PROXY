'use strict';
const {loadConfig}=require('./config-store');
const {createSseParser}=require('./sse');
const {diagnose}=require('./diagnostics');
function validateInput(input){
 const cfg=loadConfig();
 if(!input||!Object.hasOwn(cfg.upstreams,input.provider))throw new Error('Choose a configured provider');
 if(cfg.accessRevoked)throw new Error('Proxy access is revoked. Generate a new proxy key in the dashboard.');
 if(cfg.upstreams[input.provider].enabled===false)throw new Error('This channel is disabled. Enable it in Channels first.');
 if(typeof input.model!=='string'||!input.model.trim()||input.model.length>256)throw new Error('Enter a model ID');
 if(!Array.isArray(input.messages)||!input.messages.length||input.messages.length>40)throw new Error('Provide 1–40 chat messages');
 let size=0;
 const messages=input.messages.map(m=>{if(!m||!['system','user','assistant'].includes(m.role)||typeof m.content!=='string')throw new Error('Use plain text chat messages');size+=m.content.length;return{role:m.role,content:m.content};});
 if(size>32000)throw new Error('Keep conversation text under 32,000 characters');
 if(messages.at(-1).role!=='user'||!messages.at(-1).content.trim())throw new Error('Write a message first');
 const max_tokens=Number(input.maxTokens??512),temperature=Number(input.temperature??0.7);
 if(!Number.isInteger(max_tokens)||max_tokens<1||max_tokens>8192)throw new Error('Output limit must be 1–8192 tokens');
 if(!Number.isFinite(temperature)||temperature<0||temperature>2)throw new Error('Temperature must be between 0 and 2');
 const up=cfg.upstreams[input.provider];
 if(!up.apiKey&&!Object.keys(up.headers||{}).some(h=>/authorization|x-api-key/i.test(h)))throw new Error('Configure a stored provider key before using the playground');
 return{cfg,payload:{model:input.model.trim(),messages,max_tokens,temperature,stream:input.stream!==false}};
}
function textValue(v){if(typeof v==='string')return v;if(Array.isArray(v))return v.map(p=>p?.text||'').join('');return'';}
async function streamPlayground(req,res,input){
 const {cfg,payload}=validateInput(input);
 const controller=new AbortController();let timedOut=false;
 const timer=setTimeout(()=>{timedOut=true;controller.abort();},180000);timer.unref();
 res.once('close',()=>controller.abort());
 res.writeHead(200,{'content-type':'application/x-ndjson; charset=utf-8','x-accel-buffering':'no'});res.flushHeaders();
 async function send(data){if(res.destroyed||res.writableEnded)return;if(!res.write(JSON.stringify(data)+'\n'))await new Promise(resolve=>{const done=()=>{res.off('drain',done);res.off('close',done);resolve();};res.once('drain',done);res.once('close',done);});}
 let response,reader;
 try{
  const host=cfg.host==='::1'?'[::1]':(cfg.host||'127.0.0.1');
  const headers={'content-type':'application/json',accept:'text/event-stream, application/json','x-ua-source':'playground'};
  if(cfg.publicMode)headers.authorization=`Bearer ${cfg.authToken}`;
  response=await fetch(`http://${host}:${cfg.port||8787}/${input.provider}/v1/chat/completions`,{method:'POST',headers,body:JSON.stringify(payload),signal:controller.signal});
  await send({type:'meta',status:response.status,requestId:response.headers.get('x-ua-request-id'),stream:response.headers.get('content-type')?.includes('text/event-stream')||false});
  if(!response.ok){
   // Bounded read; never expose raw provider errors or echoed credentials/prompts.
   reader=response.body.getReader();let raw='';while(raw.length<16384){const chunk=await reader.read();if(chunk.done)break;raw+=new TextDecoder().decode(chunk.value).slice(0,16384-raw.length);}await reader.cancel();
   await send({type:'error',...diagnose(response.status,raw),status:response.status});return;
  }
  let finishReason=null,usage=null,failed=false,received=false,doneMarker=false,total=0;
  const events=[];
  function consume(body){
   if(body?.error){failed=true;events.push({type:'error',...diagnose(response.status,body),status:response.status});return;}
   const choice=body?.choices?.[0],value=choice?.delta||choice?.message;
   const text=textValue(value?.content)||textValue(choice?.text);
   const reasoning=textValue(value?.reasoning_content)||textValue(value?.reasoning);
   if(text){received=true;events.push({type:'delta',text});}
   if(reasoning){received=true;events.push({type:'reasoning',text:reasoning});}
   if(choice?.finish_reason)finishReason=String(choice.finish_reason).slice(0,60);
   if(body?.usage)usage={input:Number(body.usage.prompt_tokens)||0,output:Number(body.usage.completion_tokens)||0,total:Number(body.usage.total_tokens)||0};
  }
  if(response.headers.get('content-type')?.includes('text/event-stream')){
   const parser=createSseParser(({event,data})=>{
    if(data==='[DONE]'){doneMarker=true;return;}
    try{const body=JSON.parse(data);if(event==='error'&&!body.error)body.error={message:'Provider emitted a stream error'};consume(body);}catch{if(event==='error'){failed=true;events.push({type:'error',...diagnose(502,{})});}}
   });
   reader=response.body.getReader();
   for(;;){const chunk=await reader.read();if(chunk.done)break;total+=chunk.value.length;if(total>4*1024*1024)throw new Error('Response exceeded the 4 MiB playground limit');parser.push(chunk.value);while(events.length)await send(events.shift());if(failed||doneMarker){await reader.cancel();break;}}
   parser.end();while(events.length)await send(events.shift());
   if(!failed&&!doneMarker&&!finishReason)throw new Error('The stream ended before a completion marker arrived');
  }else{
   reader=response.body.getReader();let raw='';const decoder=new TextDecoder();for(;;){const chunk=await reader.read();if(chunk.done)break;total+=chunk.value.length;if(total>4*1024*1024)throw new Error('Response exceeded the 4 MiB playground limit');raw+=decoder.decode(chunk.value,{stream:true});}
   raw+=decoder.decode();let body;try{body=JSON.parse(raw);}catch{throw new Error('The provider returned neither chat JSON nor an SSE stream');}consume(body);while(events.length)await send(events.shift());
  }
  if(!failed){if(!received&&!finishReason)throw new Error('No text completion was returned by the provider');await send({type:'done',finishReason,usage});}
 }catch(error){if(!res.destroyed)await send({type:'error',kind:timedOut?'timeout':controller.signal.aborted?'cancelled':'connection',message:timedOut?'The 3-minute playground limit was reached.':controller.signal.aborted?'Generation stopped.':error.message.startsWith('Response exceeded')||error.message.startsWith('The stream ended')||error.message.startsWith('The provider returned')||error.message.startsWith('No text')?error.message:'Connection to the local proxy failed. Start the proxy and check the provider.',hint:'Review Activity for this request. No automatic retry was sent.'});}
 finally{clearTimeout(timer);if(reader){try{await reader.cancel();}catch{}}controller.abort();if(!res.writableEnded&&!res.destroyed)res.end();}
}
module.exports={streamPlayground,validateInput};

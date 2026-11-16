'use strict';
// Incremental SSE parser: handles UTF-8, CRLF, multi-line data, and chunk boundaries.
// Responses-API `response.completed` events carry the full output (including
// encrypted reasoning) and routinely exceed a few hundred KB, so the ceiling
// is deliberately generous. `onDrop` reports a dropped frame once per event.
const SSE_FRAME_LIMIT = 8 * 1024 * 1024;
function createSseParser(onEvent,{maxFrame=1024*1024,strict=true,onDrop=null}={}){
 const decoder=new TextDecoder();let buffer='',data=[],event='';let size=0,dropping=false,reported=false;
 function line(text){
  if(text===''){
   if(!dropping&&data.length)onEvent({event:event||'message',data:data.join('\n')});
   data=[];event='';size=0;dropping=false;reported=false;return;
  }
  size+=text.length;
  if(size>maxFrame){
   if(strict)throw new Error('Provider event exceeded the size limit');
   dropping=true;data=[];
   if(!reported){reported=true;onDrop?.({kind:'event',bytes:size});}
   return;
  }
  if(dropping||text.startsWith(':'))return;
  const i=text.indexOf(':');const key=i<0?text:text.slice(0,i);let value=i<0?'':text.slice(i+1);if(value.startsWith(' '))value=value.slice(1);
  if(key==='data')data.push(value);else if(key==='event')event=value;
 }
 function feed(chunk,final=false){
  buffer+=typeof chunk==='string'?chunk:decoder.decode(chunk,{stream:!final});
  let start=0;
  for(let i=0;i<buffer.length;i++){
   if(buffer[i]!=='\r'&&buffer[i]!=='\n')continue;
   if(buffer[i]==='\r'&&i===buffer.length-1&&!final)break;
   line(buffer.slice(start,i));if(buffer[i]==='\r'&&buffer[i+1]==='\n')i++;start=i+1;
  }
  buffer=buffer.slice(start);
  if(buffer.length>maxFrame){if(strict)throw new Error('Provider event exceeded the size limit');buffer='';dropping=true;onDrop?.({kind:'buffer',bytes:buffer.length});}
  if(final){if(buffer)line(buffer);line('');buffer='';}
 }
 return{push:chunk=>feed(chunk),end:()=>feed(decoder.decode(),true)};
}
module.exports={createSseParser,SSE_FRAME_LIMIT};

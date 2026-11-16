'use strict';
// Secrets are requested only on an explicit View/Copy action, not polling.
const secretWidgets=new Set();
function hideWidget(widget){
 widget.revision=(widget.revision||0)+1;clearTimeout(widget.timer);widget.field.type='password';widget.field.value='';widget.view.textContent='View';widget.view.setAttribute('aria-label','View '+widget.label);widget.visible=false;
}
window.hideSecrets=function(scope){for(const widget of secretWidgets){if(!scope||widget.scope===scope)hideWidget(widget);if(!widget.root.isConnected){hideWidget(widget);secretWidgets.delete(widget);}}};
function mountSecret(root,{scope,name,configured,label}){
 if(!root)return;for(const widget of secretWidgets){if(widget.root===root){hideWidget(widget);secretWidgets.delete(widget);}}
 root.replaceChildren();root.classList.add('secret-control');
 const field=document.createElement('input');field.type='password';field.readOnly=true;field.autocomplete='off';field.placeholder=configured?'••••••••••••••••':'Not configured';field.setAttribute('aria-label',label);
 const view=document.createElement('button');view.type='button';view.className='button secret-view';view.textContent='View';view.setAttribute('aria-label','View '+label);
 const copy=document.createElement('button');copy.type='button';copy.className='button secret-copy';copy.textContent='Copy';copy.setAttribute('aria-label','Copy '+label);
 view.disabled=copy.disabled=!configured;root.append(field,view,copy);
 const widget={root,scope,name,field,view,copy,label,visible:false,timer:null};secretWidgets.add(widget);
 async function read(){const data=await action('credential.read',{scope,name});if(!data.value)throw new Error(data.revoked?'Proxy key is revoked. Generate a new one to restore access.':'No key is stored for this channel.');return data.value;}
 view.onclick=async()=>{
  if(widget.visible){hideWidget(widget);return;}
  view.disabled=true;const revision=widget.revision||0;
  try{const value=await read();if(!root.isConnected||document.hidden||revision!==(widget.revision||0)||root.closest('.page')?.hidden)return;field.value=value;field.type='text';view.textContent='Hide';view.setAttribute('aria-label','Hide '+label);widget.visible=true;widget.timer=setTimeout(()=>hideWidget(widget),30000);}
  catch(e){toast(e.message,true);}finally{view.disabled=!configured;}
 };
 copy.onclick=async()=>{copy.disabled=true;try{const value=await read();await navigator.clipboard.writeText(value);toast('Key copied.');}catch(e){toast(e.name==='NotAllowedError'?'Clipboard unavailable. Use View to select and copy the key.':e.message,true);}finally{copy.disabled=!configured;}};
 return widget;
}
window.mountChannelCredentials=function(){for(const root of $$('[data-channel-key]')){const name=root.dataset.channelKey;mountSecret(root,{scope:'provider',name,configured:!!state.config.upstreams[name]?.keyConfigured,label:`API key for ${name}`});}};
window.mountProviderCredential=function(name,upstream){
 window.hideSecrets();$('#stored-provider-key').hidden=!name;
 mountSecret($('#provider-key-widget'),{scope:'provider',name,configured:!!upstream?.keyConfigured,label:'stored provider API key'});
 $('#revoke-provider-key').disabled=!name||!upstream?.keyConfigured;
};
let proxyCredentialSignature='';
window.renderCredentials=function(){
 if(!state)return;
 const cfg=state.config;const signature=JSON.stringify([cfg.tokenConfigured,cfg.accessRevoked,cfg.publicMode]);
 $('#proxy-key-status').textContent=cfg.accessRevoked?'Revoked · access blocked':cfg.tokenConfigured?cfg.publicMode?'Active':'Stored · auth optional':'Not configured';
 $('#proxy-key-status').classList.toggle('key-revoked',cfg.accessRevoked===true);
 $('#generate-proxy-key').disabled=busy;
 $('#revoke-proxy-key').disabled=busy||!cfg.tokenConfigured||cfg.accessRevoked===true;
 if(signature!==proxyCredentialSignature){proxyCredentialSignature=signature;mountSecret($('#proxy-key-widget'),{scope:'proxy',configured:!!cfg.tokenConfigured,label:'proxy API key'});}
};
async function mutateProxyKey(kind){
 const revoked=kind==='revoke';
 if(!await confirmAction(revoked?'Revoke proxy API key?':'Generate a new proxy API key?',revoked?'This blocks API access, including Playground, until a new proxy key is generated. The local dashboard stays available.':'The current proxy key becomes invalid. Update your clients to use the new key. Provider API keys are kept.',revoked?'Revoke key':'Generate new'))return;
 window.hideSecrets();
 await run($(revoked?'#revoke-proxy-key':'#generate-proxy-key'),async()=>{const r=await action(revoked?'token.revoke':'token.generate');proxyCredentialSignature='';toast(r.message);});
}
$('#generate-proxy-key').onclick=()=>mutateProxyKey('generate');$('#revoke-proxy-key').onclick=()=>mutateProxyKey('revoke');
$('#revoke-provider-key').onclick=async()=>{
 const name=$('#provider-form').elements.name.value;
 if(!await confirmAction('Remove this stored provider key?',`${name} will be disabled locally and its stored API key removed. To invalidate the key at the provider, revoke it in that provider’s account dashboard.`,'Remove & disable'))return;
 window.hideSecrets();await run($('#revoke-provider-key'),async()=>{toast((await action('provider.revoke',{name})).message);$('#provider-dialog').close();});
};
$('#provider-dialog').addEventListener('cancel',()=>window.hideSecrets());
$('#provider-dialog').addEventListener('close',()=>{window.hideSecrets();$('#provider-form').elements.apiKey.value='';});
document.addEventListener('visibilitychange',()=>{if(document.hidden)window.hideSecrets();});
document.addEventListener('click',e=>{if(e.target.closest('.close-dialog,nav a,.brand'))window.hideSecrets();},true);
window.addEventListener('pagehide',()=>window.hideSecrets());

if(state){window.renderCredentials();window.mountChannelCredentials();}

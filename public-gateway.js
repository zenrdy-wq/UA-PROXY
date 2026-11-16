'use strict';
const http=require('node:http');
const {loadConfig}=require('./config-store');
const {URL}=require('node:url');
const HOP=new Set(['host','connection','keep-alive','proxy-authenticate','proxy-authorization','te','trailer','transfer-encoding','upgrade','cookie','set-cookie','x-forwarded-for','x-forwarded-host','x-forwarded-proto','x-real-ip','forwarded','x-ua-public-gateway','x-ua-remote-ui']);
function isGatewayPath(target){const p=new URL(target,'http://localhost').pathname;return /^\/v1(?:\/|$)/.test(p)||/^\/[a-z][a-z0-9_-]{0,31}\/v1(?:\/|$)/.test(p);}
function forwardGateway(req,res){
 const cfg=loadConfig();
 const headers={};for(const[k,v]of Object.entries(req.headers)){if(!HOP.has(k.toLowerCase()))headers[k]=v;}
 // The gateway always validates the proxy token on this hop, even if local
 // passthrough mode is selected. Never forward dashboard Basic credentials.
 headers['x-ua-public-gateway']='1';
 if(!String(headers.authorization||'').startsWith('Bearer '))delete headers.authorization;
 const request=http.request({hostname:cfg.host||'127.0.0.1',port:cfg.port||8787,path:req.url,method:req.method,headers},response=>{
  const out={};for(const[k,v]of Object.entries(response.headers)){if(!HOP.has(k.toLowerCase()))out[k]=v;}
  res.writeHead(response.statusCode||502,out);response.pipe(res);
  response.on('error',()=>res.destroy());response.on('aborted',()=>res.destroy());
  res.on('close',()=>{if(!res.writableFinished){response.destroy();request.destroy();}});
 });
 request.on('error',()=>{if(res.headersSent){res.destroy();return;}res.writeHead(503,{'content-type':'application/json'});res.end(JSON.stringify({error:{message:'Proxy is unavailable. Start it from the dashboard.'}}));});
 req.on('aborted',()=>request.destroy());res.on('close',()=>{if(!res.writableFinished)request.destroy();});req.pipe(request);
}
module.exports={isGatewayPath,forwardGateway};

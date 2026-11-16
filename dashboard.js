#!/usr/bin/env node
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes, timingSafeEqual } = require('node:crypto');
const { snapshot, perform, sanitize, getHistory } = require('./manager');
const { streamPlayground } = require('./playground');
const { isGatewayPath, forwardGateway } = require('./public-gateway');
let activePlaygrounds = 0;
const port = Number(process.env.UA_DASHBOARD_PORT || 8788);
const sessions = new Map();
const assets = { '/': ['index.html','text/html'], '/app.js': ['app.js','text/javascript'],
  '/credentials.js': ['credentials.js','text/javascript'], '/features.js': ['features.js','text/javascript'], '/style.css': ['style.css','text/css'], '/icon.svg': ['icon.svg','image/svg+xml'] };
function equal(a,b) {
  const aa = Buffer.from(String(a || '')), bb = Buffer.from(String(b || ''));
  return aa.length === bb.length && timingSafeEqual(aa,bb);
}
function json(res, status, data) { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); }
const server = http.createServer(async (req,res) => {
  res.setHeader('Cache-Control','no-store');
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Referrer-Policy','no-referrer');
  res.setHeader('X-Frame-Options','DENY');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  const host = req.headers.host;
  if (![ `127.0.0.1:${port}`, `localhost:${port}` ].includes(host)) return json(res,403,{error:'Invalid local host'});
  const url = new URL(req.url,`http://${host}`);
  if (req.headers['x-ua-public-gateway'] === '1' && isGatewayPath(req.url)) return forwardGateway(req,res);
  if (req.headers.origin && req.headers.origin !== `http://${host}`) return json(res,403,{error:'Cross-origin request refused'});
  const navigation = req.method === 'GET' && url.pathname === '/' && req.headers['sec-fetch-mode'] === 'navigate';
  if (req.headers['sec-fetch-site'] && !['same-origin','none'].includes(req.headers['sec-fetch-site']) && !navigation) return json(res,403,{error:'Open the dashboard directly'});
  if (req.method === 'GET' && Object.hasOwn(assets,url.pathname)) {
    const [file,type] = assets[url.pathname];
    res.writeHead(200, {'content-type':`${type}; charset=utf-8`});
    return fs.createReadStream(path.join(__dirname,'web',file)).pipe(res);
  }
  const now = Date.now();
  for (const [key,session] of sessions) if (now - session.at > 12*3600000) sessions.delete(key);
  const cookie = /(?:^|;\s*)ua_session=([a-f0-9]+)/.exec(req.headers.cookie || '')?.[1];
  let session = sessions.get(cookie);
  if (req.method === 'GET' && url.pathname === '/api/session') {
    if (!session) {
      if (sessions.size > 64) sessions.delete(sessions.keys().next().value);
      const id = randomBytes(32).toString('hex');
      session = { csrf: randomBytes(32).toString('hex'), at: now }; sessions.set(id,session);
      res.setHeader('Set-Cookie',`ua_session=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${req.headers['x-ua-remote-ui']==='1'?'; Secure':''}`);
    }
    return json(res,200,{csrf:session.csrf});
  }
  if (!session) return json(res,401,{error:'Reload the dashboard to begin a local session'});
  try {
    if (req.method === 'GET' && url.pathname === '/api/state') return json(res,200,await snapshot());
    if (req.method === 'GET' && url.pathname === '/api/history') return json(res,200,getHistory().query(Object.fromEntries(url.searchParams)));
    if (req.method === 'GET' && url.pathname === '/api/request') {
      const row = getHistory().get(url.searchParams.get('id'));
      return json(res,row ? 200 : 404,row || {error:'Request not found or no longer retained'});
    }
    if (req.method !== 'POST' || !['/api/action','/api/playground'].includes(url.pathname)) return json(res,404,{error:'Not found'});
    if (!equal(req.headers['x-csrf-token'],session.csrf)) return json(res,403,{error:'Invalid session token'});
    if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) return json(res,415,{error:'Use JSON'});
    let body = '';
    for await (const chunk of req) {
      body += chunk;
      if (Buffer.byteLength(body) > 65536) return json(res,413,{error:'Request too large'});
    }
    const data = JSON.parse(body);
    if (url.pathname === '/api/playground') {
      if (activePlaygrounds >= 4 || session.generating) return json(res,429,{error:'A generation is already running. Stop it before starting another.'});
      activePlaygrounds++; session.generating = true;
      try { await streamPlayground(req,res,data); } finally { activePlaygrounds--; session.generating = false; }
      return;
    }
    const result = await perform(data.action,data.input || {});
    json(res,200,result);
  } catch (error) { json(res,400,{error:sanitize(error.message)}); }
});
server.requestTimeout = 15000; server.headersTimeout = 10000;
server.listen(port,'127.0.0.1',() => console.log(`UA Proxy dashboard: http://127.0.0.1:${port}`));
for (const signal of ['SIGTERM','SIGINT']) process.on(signal,() => { server.close(); setTimeout(() => process.exit(0),1000).unref(); });

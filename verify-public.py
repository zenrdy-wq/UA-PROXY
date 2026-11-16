#!/usr/bin/env python3
import json,urllib.request,urllib.error,base64,socket,ipaddress
from pathlib import Path
r=Path(__file__).resolve().parent;m=json.loads((r/'runtime/public-access.json').read_text());c=json.loads((r/'remote-credentials.json').read_text());origin=m['origin'];host=origin.split('://',1)[1]
q=urllib.request.Request('https://dns.google/resolve?name='+host+'&type=A',headers={'Accept':'application/dns-json'})
dns=json.load(urllib.request.urlopen(q,timeout=15));public=[x['data'] for x in dns.get('Answer',[]) if x['type']==1]
assert public and all(ipaddress.ip_address(ip).is_global for ip in public),'Public ingress missing'
original_getaddrinfo=socket.getaddrinfo
socket.getaddrinfo=lambda h,p,*a,**k:original_getaddrinfo(public[0] if h==host else h,p,*a,**k)
def fetch(path,headers=None,method=None,body=None):
 req=urllib.request.Request(origin+path,headers=headers or {},method=method,data=body)
 try:
  with urllib.request.urlopen(req,timeout=30) as response:return response.status,dict(response.headers),response.read()
 except urllib.error.HTTPError as error:return error.code,dict(error.headers),error.read()
for path,headers,expected in [('/',{},401),('/api/session',{},401),('/api/state',{},401),('/v1/models',{},401),('/v1/models',{'Authorization':'Bearer invalid-test-key'},401)]:
 code,_,_=fetch(path,headers);assert code==expected,(path,code)
basic='Basic '+base64.b64encode((c['username']+':'+c['password']).encode()).decode()
code,_,b=fetch('/',{'Authorization':basic});assert code==200 and b'UA Proxy' in b
code,h,b=fetch('/api/session',{'Authorization':basic});assert code==200;session=json.loads(b);cookie=next(v for k,v in h.items() if k.lower()=='set-cookie');assert all(flag in cookie for flag in ['Secure','HttpOnly','SameSite=Strict'])
headers={'Authorization':basic,'Cookie':cookie.split(';',1)[0]}
code,_,body=fetch('/api/state',headers);state=json.loads(body);assert code==200 and state['publicEndpoint']==origin
cfg=json.loads((r/'config.json').read_text());assert cfg['authToken'].encode() not in body;assert all(not u.get('apiKey') or u['apiKey'].encode() not in body for u in cfg['upstreams'].values())
code,_,_=fetch('/api/action',{**headers,'Origin':'https://evil.example','Content-Type':'application/json','X-CSRF-Token':session['csrf']},'POST',b'{"action":"credential.read","input":{"scope":"proxy"}}');assert code==403
code,_,_=fetch('/v1/models',{'Authorization':basic});assert code==401
result={'origin':origin,'publicIngress':public,'tlsVerified':True,'dashboardLogin':'passed','secureSessionCookie':'passed','anonymousManagementBlocked':True,'missingInvalidProxyKeyBlocked':True,'dashboardPasswordNotApiKey':True,'crossOriginBlocked':True,'stateSecretsRedacted':True,'providers':len(state['config']['upstreams']),'realProviderRequestsSent':0}
(r/'runtime'/'funnel-verification.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result,indent=2))

#!/usr/bin/env python3
"""Generate the private Funnel edge config, without printing credentials."""
from pathlib import Path
from urllib.parse import urlsplit
import json,subprocess,secrets,os,re
root=Path(__file__).resolve().parent
status=json.loads(subprocess.check_output(['tailscale','status','--json']))
if status.get('BackendState')!='Running':raise SystemExit('Log this VPS into Tailscale first.')
host=status.get('Self',{}).get('DNSName','').rstrip('.')
if not re.fullmatch(r'[a-z0-9.-]+\.ts\.net',host):raise SystemExit('A valid Tailscale DNS name is required.')
origin='https://'+host
credential_file=root/'remote-credentials.json'
if credential_file.exists():credentials=json.loads(credential_file.read_text())
else:
 password=secrets.token_urlsafe(32)
 result=subprocess.run([str(root/'caddy-funnel'),'hash-password','--algorithm','argon2id'],input=password+'\n',text=True,capture_output=True,check=True)
 credentials={'username':os.environ.get('UA_DASHBOARD_USER','admin'),'password':password,'passwordHash':result.stdout.strip()}
 if not credentials['passwordHash'].startswith('$argon2id$'):raise SystemExit('Password hashing failed.')
 credential_file.write_text(json.dumps(credentials,indent=2)+'\n');credential_file.chmod(0o600)
hash_value=credentials['passwordHash']
config='''{
 admin off
 auto_https off
 skip_install_trust
}
http://:8790 {
 bind 127.0.0.1
 header {
  Strict-Transport-Security "max-age=31536000"
  X-Content-Type-Options nosniff
  Referrer-Policy no-referrer
  Cache-Control no-store
  -Server
 }
 route {
  @bad_host not host HOST 127.0.0.1 localhost
  respond @bad_host "Invalid host" 403
  @foreign_origin {
   header Origin *
   not header Origin ORIGIN
  }
  respond @foreign_origin "Cross-origin request refused" 403
  @gateway path_regexp gateway ^/(?:v1(?:/|$)|[a-z][a-z0-9_-]{0,31}/v1(?:/|$))
  handle @gateway {
   reverse_proxy 127.0.0.1:8788 {
    flush_interval -1
    header_up Host 127.0.0.1:8788
    header_up X-UA-Public-Gateway 1
    header_up -X-UA-Remote-UI
    header_up -X-UA-Source
    header_up -Cookie
   }
  }
  handle {
   basic_auth argon2id "UA Proxy Dashboard" {
    USER HASH
   }
   reverse_proxy 127.0.0.1:8788 {
    flush_interval -1
    header_up Host 127.0.0.1:8788
    header_up Origin http://127.0.0.1:8788
    header_up -Authorization
    header_up -X-UA-Public-Gateway
    header_up -X-UA-Source
    header_up X-UA-Remote-UI 1
   }
  }
 }
}
'''.replace('HOST',host).replace('ORIGIN',origin).replace('USER',credentials['username']).replace('HASH',hash_value)
target=root/'Funnel.Caddyfile';target.write_text(config);target.chmod(0o600)
subprocess.run([str(root/'caddy-funnel'),'validate','--config',str(target),'--adapter','caddyfile'],check=True,capture_output=True)
metadata={'origin':origin,'dashboard':origin+'/','apiBase':origin+'/v1','dashboardUsername':credentials['username'],'edgePort':8790}
p=root/'runtime'/'public-access.json';p.write_text(json.dumps(metadata,indent=2)+'\n');p.chmod(0o600)
print(json.dumps({'origin':origin,'configured':True,'dashboardUsername':credentials['username']}))

'use strict';
const fs=require('node:fs');const path=require('node:path');const {DatabaseSync}=require('node:sqlite');const {createHash,randomUUID}=require('node:crypto');
const {legacyDiagnosis}=require('./diagnostics');
const RETENTION_DAYS=30,MAX_ROWS=50000;
function historyPath(metrics=process.env.UA_PROXY_METRICS||path.join(__dirname,'runtime','metrics.json')){return process.env.UA_PROXY_HISTORY||path.join(path.dirname(metrics),'history.sqlite');}
function openHistory(file=historyPath()){
 fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
 const db=new DatabaseSync(file);fs.chmodSync(file,0o600);
 db.exec(`PRAGMA busy_timeout=2000; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;
 CREATE TABLE IF NOT EXISTS requests(id TEXT PRIMARY KEY, at INTEGER NOT NULL, method TEXT NOT NULL,
 upstream TEXT NOT NULL, endpoint TEXT NOT NULL, status INTEGER NOT NULL, duration_ms INTEGER NOT NULL,
 diagnosis TEXT, upstream_status INTEGER, origin TEXT NOT NULL DEFAULT 'proxy');
 CREATE INDEX IF NOT EXISTS requests_at ON requests(at DESC);
 CREATE INDEX IF NOT EXISTS requests_provider_at ON requests(upstream,at DESC);
 CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);`);
 const insert=db.prepare('INSERT OR IGNORE INTO requests(id,at,method,upstream,endpoint,status,duration_ms,diagnosis,upstream_status,origin) VALUES(?,?,?,?,?,?,?,?,?,?)');
 let writes=0;
 function prune(){db.prepare('DELETE FROM requests WHERE at < ?').run(Date.now()-RETENTION_DAYS*86400000);db.exec(`DELETE FROM requests WHERE id IN (SELECT id FROM requests ORDER BY at DESC LIMIT -1 OFFSET ${MAX_ROWS})`);}
 function record(row){
  insert.run(row.id||randomUUID(),row.at,row.method,row.upstream,row.endpoint,row.status,Math.round(row.durationMs),row.diagnosis?JSON.stringify(row.diagnosis):null,row.upstreamStatus??null,row.origin||'proxy');
  if(++writes%100===0)prune();
 }
 function map(row){if(!row)return null;const{duration_ms,diagnosis,upstream_status,...rest}=row;return{...rest,durationMs:duration_ms,upstreamStatus:upstream_status,diagnosis:diagnosis?JSON.parse(diagnosis):null};}
 function query({range='24h',provider='',status='all',q='',page=1,limit=25}={}){
  const days={'24h':1,'7d':7,'30d':30,all:30};if(!Object.hasOwn(days,range))throw new Error('Invalid history range');
  if(!['all','errors','success'].includes(status))throw new Error('Invalid status filter');
  page=Math.max(1,Math.min(2000,Math.floor(Number(page)||1)));limit=Math.max(1,Math.min(100,Math.floor(Number(limit)||25)));
  const clauses=['at >= ?'];const args=[Date.now()-days[range]*86400000];
  if(provider){clauses.push('upstream = ?');args.push(String(provider).slice(0,32));}
  if(status==='errors')clauses.push('status >= 400');if(status==='success')clauses.push('status < 400');
  if(q){clauses.push("(upstream LIKE ? ESCAPE '\\' OR endpoint LIKE ? ESCAPE '\\' OR CAST(status AS TEXT) LIKE ? ESCAPE '\\' OR id LIKE ? ESCAPE '\\')");const term='%'+String(q).slice(0,100).replace(/[\\%_]/g,c=>'\\'+c)+'%';args.push(term,term,term,term);}
  const where=clauses.join(' AND ');
  const stats=db.prepare(`SELECT COUNT(*) AS total,COALESCE(SUM(status>=400),0) AS errors,COALESCE(SUM(duration_ms),0) AS durationMs FROM requests WHERE ${where}`).get(...args);
  const pages=Math.max(1,Math.ceil(stats.total/limit));page=Math.min(page,pages);
  const rows=db.prepare(`SELECT * FROM requests WHERE ${where} ORDER BY at DESC,id DESC LIMIT ? OFFSET ?`).all(...args,limit,(page-1)*limit).map(map);
  return{rows,...stats,page,pages,limit,retentionDays:RETENTION_DAYS,maxRows:MAX_ROWS};
 }
 function summary(){
  const summary=query({range:'all',limit:60});
  const buckets=db.prepare('SELECT CAST(at/60000 AS INTEGER)*60000 AS at,COUNT(*) AS count,SUM(status>=400) AS errors FROM requests WHERE at>=? GROUP BY CAST(at/60000 AS INTEGER) ORDER BY at').all(Date.now()-60*60000);
  return{total:summary.total,errors:summary.errors,durationMs:summary.durationMs,recent:summary.rows,buckets,retentionDays:RETENTION_DAYS,maxRows:MAX_ROWS};
 }
 function importLegacy(metricsFile){
  if(db.prepare("SELECT value FROM metadata WHERE key='legacy_imported'").get())return;
  let old;try{old=JSON.parse(fs.readFileSync(metricsFile,'utf8'));}catch{}
  db.exec('BEGIN IMMEDIATE');
  try{
   for(const r of old?.recent||[]){if(!Number.isFinite(r.at)||!Number.isFinite(r.status)||!Number.isFinite(r.durationMs))continue;
    const id='legacy-'+createHash('sha256').update(JSON.stringify([r.at,r.method,r.upstream,r.endpoint,r.status,r.durationMs])).digest('hex').slice(0,24);
    record({...r,id,diagnosis:legacyDiagnosis(r.status),origin:'legacy'});
   }
   db.prepare("INSERT OR IGNORE INTO metadata(key,value) VALUES('legacy_imported','1')").run();db.exec('COMMIT');
  }catch(e){db.exec('ROLLBACK');throw e;}
  prune();
 }
 prune();
 return{record,query,summary,importLegacy,get:id=>map(db.prepare('SELECT * FROM requests WHERE id=? AND at>=?').get(String(id),Date.now()-RETENTION_DAYS*86400000)),close:()=>db.close(),prune};
}
module.exports={openHistory,historyPath,RETENTION_DAYS,MAX_ROWS};

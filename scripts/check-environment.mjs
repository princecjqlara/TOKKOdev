// Read-only configuration checks. Reports names/statuses, never credentials.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import nextEnv from '@next/env';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const expected=JSON.parse(fs.readFileSync(path.join(root,'config/deployment.json'),'utf8'));
nextEnv.loadEnvConfig(root,true,{info(){},error(){}},true);
const env=process.env,failures=[],checks=[];
function check(name,passed){checks.push({name,passed:!!passed});if(!passed)failures.push(name);}
const databaseKeys=['NEXT_PUBLIC_SUPABASE_URL','SUPABASE_URL','NEXT_PUBLIC_SUPABASE_ANON_KEY','SUPABASE_ANON_KEY','SUPABASE_SERVICE_ROLE_KEY','DATABASE_URL','DATABASE_POOLER_URL_5432','DATABASE_POOLER_URL_6543'];
for(const key of databaseKeys)check('configured:'+key,!!env[key]?.trim());
function databaseUrlMatches(value){try{const url=new URL(value);return url.hostname===expected.databaseProject+'.supabase.co';}catch{return false;}}
check('public_database_project',databaseUrlMatches(env.NEXT_PUBLIC_SUPABASE_URL));
check('server_database_project',databaseUrlMatches(env.SUPABASE_URL));
check('publishable_key_aliases_match',!!env.SUPABASE_ANON_KEY&&env.SUPABASE_ANON_KEY===env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
for(const key of databaseKeys.filter(k=>k.startsWith('DATABASE_'))){let matches=false;try{const u=new URL(env[key]);matches=u.hostname==='db.'+expected.databaseProject+'.supabase.co'||decodeURIComponent(u.username).endsWith('.'+expected.databaseProject);}catch{}check('postgres_project:'+key,matches);}
const linkPath=path.join(root,'.vercel/project.json');let link={};try{link=JSON.parse(fs.readFileSync(linkPath,'utf8'));}catch{}
check('vercel_project_link',link.projectId===expected.projectId&&link.orgId===expected.teamId&&link.projectName===expected.projectName);
for(const key of ['NEXTAUTH_SECRET','FACEBOOK_CLIENT_ID','FACEBOOK_CLIENT_SECRET','FACEBOOK_APP_SECRET','NVIDIA_API_KEY'])check('configured:'+key,!!env[key]?.trim());
let localOrigin=false;try{const u=new URL(env.NEXTAUTH_URL);localOrigin=env.NEXTAUTH_URL===expected.productionOrigin||['localhost','127.0.0.1'].includes(u.hostname);}catch{}
check('authentication_origin',localOrigin);
check('facebook_webhook_origin',env.FACEBOOK_WEBHOOK_URL===expected.productionOrigin+'/api/facebook/webhook');
check('facebook_secret_aliases_match',!!env.FACEBOOK_APP_SECRET&&env.FACEBOOK_APP_SECRET===env.FACEBOOK_CLIENT_SECRET);
check('production_debug_disabled',env.NEXTAUTH_DEBUG!=='true');
check('administrator_uses_protected_database',!env.SYSTEM_ADMIN_EMAIL&&!env.SYSTEM_ADMIN_PASSWORD_HASH);
const report={project:expected.projectName,production:expected.productionOrigin,database:expected.databaseProject,read_only:true};
try{
 if(process.argv.includes('--vercel')){
  const auth=JSON.parse(fs.readFileSync(path.join(env.APPDATA,'com.vercel.cli/Data/auth.json'),'utf8'));
  async function api(p){const r=await fetch('https://api.vercel.com'+p+(p.includes('?')?'&':'?')+'teamId='+expected.teamId,{headers:{Authorization:'Bearer '+auth.token},signal:AbortSignal.timeout(30000)});if(!r.ok)throw Error('Vercel HTTP '+r.status);return r.json();}
  const project=await api('/v9/projects/'+expected.projectId);check('remote_project_name',project.name===expected.projectName);
  const rows=(await api('/v10/projects/'+expected.projectId+'/env')).envs;
  const production=rows.filter(r=>r.target?.includes('production')&&!r.gitBranch);
  report.production_variables_checked=production.length;
  for(const row of production){const actual=await api('/v1/projects/'+expected.projectId+'/env/'+row.id);const urlKey=['NEXTAUTH_URL','FACEBOOK_WEBHOOK_URL'].includes(row.key);check('production_match:'+row.key,urlKey?actual.value===expected.productionOrigin+(row.key==='FACEBOOK_WEBHOOK_URL'?'/api/facebook/webhook':''):actual.value===env[row.key]);}
  for(const key of databaseKeys)for(const scope of ['production','preview','development']){const matching=rows.filter(r=>r.key===key&&r.target?.includes(scope));check('database_scope:'+scope+':'+key,matching.length>0);for(const row of matching){const actual=await api('/v1/projects/'+expected.projectId+'/env/'+row.id);check('database_scope_value:'+scope+':'+key,actual.value===env[key]);}}
  const deployed=project.targets?.production?.id?await api('/v13/deployments/'+project.targets.production.id):null;
  check('production_deployment_ready',deployed?.readyState==='READY');report.production_deployment=deployed?.id;
 }
 if(process.argv.includes('--live')||process.argv.includes('--vercel')){
  const headers={apikey:env.SUPABASE_SERVICE_ROLE_KEY,Authorization:'Bearer '+env.SUPABASE_SERVICE_ROLE_KEY};
  for(const [table,columns]of [['users','id'],['pages','id'],['contacts','id'],['campaigns','failure_counts,last_error_diagnostic'],['campaign_delivery_failures','diagnostic']]){const r=await fetch(env.SUPABASE_URL+'/rest/v1/'+table+'?select='+columns+'&limit=0',{headers,signal:AbortSignal.timeout(15000)});check('live_database:'+table,r.status===200);}
  const r=await fetch(env.SUPABASE_URL+'/rest/v1/rpc/tokko_system_admin_credentials',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:'{}',signal:AbortSignal.timeout(15000)});const rows=await r.json();check('protected_administrator_configured',r.ok&&rows[0]?.email&&rows[0]?.password_hash&&rows[0]?.revision);
 }
}catch(error){failures.push('external_check_failed');report.external_error=error.message?.startsWith('Vercel HTTP ')?error.message:(error.code||error.name);}
report.passed=failures.length===0;report.checks=checks.length;report.failed_checks=failures;console.log(JSON.stringify(report,null,2));if(failures.length)process.exitCode=1;

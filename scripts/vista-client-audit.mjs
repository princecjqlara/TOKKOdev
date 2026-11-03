import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { Resolver } from 'node:dns/promises';
import { createClient } from '@supabase/supabase-js';
for (const line of fs.readFileSync('.env.local','utf8').split(/\r?\n/)) {
  const m=line.match(/^\s*([^#=]+)=(.*)$/); if(m) process.env[m[1].trim()]=m[2].trim().replace(/^['"]|['"]$/g,'');
}
const db=createClient(process.env.NEXT_PUBLIC_SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
export {db};
export const out=path.resolve('analysis-output/vista-2026-09-15');
fs.mkdirSync(out,{recursive:true});
export async function all(query) { const rows=[]; for(let n=0;;n+=500) {const r=await query().range(n,n+499);if(r.error)throw new Error(r.error.message);rows.push(...r.data);if(r.data.length<500)break;}return rows;}
export const pageId='142b8647-c785-4205-a558-5e0cb26d7151';
export const paidTagId='c7564310-6b2d-4f09-ac48-b16f52aae9e8';
if(process.argv[2]==='exports') {
 const rows=await all(()=>db.from('conversation_export_jobs').select('id,status,scope,conversation_count,message_count,chunk_count,storage_prefix,filename,created_at,expires_at').eq('page_id',pageId).order('created_at',{ascending:false}));
 console.log(JSON.stringify(rows,null,2));
 const history=await all(()=>db.from('page_activity_history').select('action_type,summary,target_count,details,created_at').eq('page_id',pageId).order('created_at',{ascending:false}).limit(100));
 fs.writeFileSync(path.join(out,'activity-history.json'),JSON.stringify(history,null,2));
 console.log(JSON.stringify(history.map(({details,...r})=>r).slice(0,20),null,2));
}
if(process.argv[2]==='download-export') {
 const {data:job,error}=await db.from('conversation_export_jobs').select('storage_prefix').eq('id','69e7da73-aa62-4d75-9f3d-6ae7f1bfa33c').eq('page_id',pageId).single();if(error)throw new Error(error.message);
 const {data:files,error:listError}=await db.storage.from('conversation-exports').list(job.storage_prefix,{limit:1000,sortBy:{column:'name',order:'asc'}});if(listError)throw new Error(listError.message);
 const dir=path.join(out,'export-chunks');fs.mkdirSync(dir,{recursive:true});
 console.log(JSON.stringify({files:files.length,names:files.slice(0,3).map(f=>f.name)}));
 for(const file of files){const target=path.join(dir,file.name);if(fs.existsSync(target))continue;const {data,error}=await db.storage.from('conversation-exports').download(`${job.storage_prefix}/${file.name}`);if(error)throw new Error(error.message);fs.writeFileSync(target,Buffer.from(await data.arrayBuffer()));}
 console.log('Saved export chunks');
}
const graphResolver=new Resolver();graphResolver.setServers(['1.1.1.1']);let graphAddress;
async function graphGet(url){
 const parsed=new URL(url);if(parsed.hostname!=='graph.facebook.com')throw new Error('Unexpected API hostname');
 if(!graphAddress)graphAddress=(await graphResolver.resolve4(parsed.hostname))[0];
 return await new Promise((resolve,reject)=>{const req=https.get(parsed,{lookup:(_host,opts,cb)=>cb(null,opts?.all?[{address:graphAddress,family:4}]:graphAddress,4),timeout:30000},res=>{let s='';res.setEncoding('utf8');res.on('data',v=>s+=v);res.on('end',()=>{try{resolve({ok:res.statusCode>=200&&res.statusCode<300,status:res.statusCode,body:JSON.parse(s)});}catch{reject(new Error('Invalid API response'));}});});req.on('error',reject);req.on('timeout',()=>req.destroy(new Error('Facebook request timeout')));});
}
async function graph(url){
 for(let attempt=0;attempt<6;attempt++){
  let response;
  try{response=await graphGet(url);}catch(e){graphAddress=null;if(attempt===5)throw e;await new Promise(r=>setTimeout(r,1000*2**attempt));continue;}
  const body=response.body;
  if(response.ok&&!body.error)return body;
  if(attempt===5||(!body.error?.is_transient&&response.status!==429&&response.status<500))throw new Error(body.error?.message||`HTTP ${response.status}`);
  await new Promise(r=>setTimeout(r,1000*2**attempt));
 }
}
if(process.argv[2]==='prefetch') {
 const {data:page,error}=await db.from('pages').select('access_token').eq('id',pageId).single();if(error)throw new Error(error.message);
 const progress=JSON.parse(fs.readFileSync(path.join(out,'conversation-list-progress.json'),'utf8'));
 const conversations=progress.conversations.slice(Number(process.argv[3]||0),Number(process.argv[4]||500));
 const dir=path.join(out,'messages');fs.mkdirSync(dir,{recursive:true});let next=0,done=0,errors=0;
 async function worker(){while(next<conversations.length){const c=conversations[next++];const target=path.join(dir,encodeURIComponent(c.id)+'.json');if(fs.existsSync(target)){done++;continue;}try{let url=`https://graph.facebook.com/v21.0/${c.id}/messages?fields=id,message,from,created_time&limit=100&access_token=${encodeURIComponent(page.access_token)}`;const messages=[];while(url){const body=await graph(url);messages.push(...(body.data||[]));url=body.paging?.next;}fs.writeFileSync(target,JSON.stringify({conversationId:c.id,participants:c.participants,updatedTime:c.updated_time,messages}));}catch{errors++;}done++;if(done%50===0)console.log(`Prefetched ${done}/${conversations.length}; errors ${errors}`);}}
 await Promise.all(Array.from({length:6},worker));console.log('Prefetch complete');
}
if(process.argv[2]==='fetch') {
 const {data:page,error}=await db.from('pages').select('id,fb_page_id,name,access_token').eq('id',pageId).single();if(error)throw new Error(error.message);
 const [contacts,tags]=await Promise.all([
  all(()=>db.from('contacts').select('id,psid,name,created_at,last_interaction_at').eq('page_id',pageId).order('id')),
  all(()=>db.from('contact_tags').select('contact_id,tag_id,created_at,contacts!inner(page_id)').eq('contacts.page_id',pageId).order('id'))
 ]);
 fs.writeFileSync(path.join(out,'contacts.json'),JSON.stringify(contacts));fs.writeFileSync(path.join(out,'tags-before.json'),JSON.stringify(tags));
 console.log(JSON.stringify({contacts:contacts.length,tagAssignments:tags.length,paidTagged:tags.filter(t=>t.tag_id===paidTagId).length}));
 const convPath=path.join(out,'conversations.json');
 let conversations=[];
 if(fs.existsSync(convPath))conversations=JSON.parse(fs.readFileSync(convPath,'utf8'));
 else {
 const partialPath=path.join(out,'conversation-list-progress.json');
 const partial=fs.existsSync(partialPath)?JSON.parse(fs.readFileSync(partialPath,'utf8')):null;
 if(partial)conversations=partial.conversations;
 let url=`https://graph.facebook.com/v21.0/${page.fb_page_id}/conversations?fields=id,participants,updated_time&limit=100&access_token=${encodeURIComponent(page.access_token)}`+(partial?.cursor?`&after=${encodeURIComponent(partial.cursor)}`:'');
 while(url){const body=await graph(url);conversations.push(...(body.data||[]));url=body.paging?.next;fs.writeFileSync(partialPath,JSON.stringify({conversations,cursor:body.paging?.cursors?.after||null,complete:!url}));if(conversations.length%500===0)console.log(`Listed ${conversations.length} conversations`);}
 fs.writeFileSync(convPath,JSON.stringify(conversations));
 }
 console.log(`Conversations available: ${conversations.length}`);
 const dir=path.join(out,'messages');fs.mkdirSync(dir,{recursive:true});
 let next=0,done=0,failed=0;const errors=[];
 async function worker(){while(next<conversations.length){const c=conversations[next++];const target=path.join(dir,encodeURIComponent(c.id)+'.json');if(fs.existsSync(target)){done++;continue;}
 try{
 let url=`https://graph.facebook.com/v21.0/${c.id}/messages?fields=id,message,from,created_time&limit=100&access_token=${encodeURIComponent(page.access_token)}`;
 const messages=[];const seen=new Set();
 while(url){if(seen.has(url))throw new Error('Repeated pagination URL');seen.add(url);const body=await graph(url);messages.push(...(body.data||[]));url=body.paging?.next;}
 fs.writeFileSync(target,JSON.stringify({conversationId:c.id,participants:c.participants,updatedTime:c.updated_time,messages}));
 }catch(e){failed++;errors.push({conversationId:c.id,error:e.message});}
 done++;if(done%100===0)console.log(`Fetched ${done}/${conversations.length}; errors ${failed}`);
 }}
 await Promise.all(Array.from({length:8},worker));
 fs.writeFileSync(path.join(out,'fetch-errors.json'),JSON.stringify(errors,null,2));
 console.log(JSON.stringify({complete:true,conversations:conversations.length,failed}));
}
if(process.argv[2]==='discover') {
 const pages=await all(()=>db.from('pages').select('id,fb_page_id,name,last_synced_at').ilike('name','%vista%').order('id'));
 console.log(JSON.stringify(pages,null,2));
 for(const p of pages){
 const [tags,counts]=await Promise.all([all(()=>db.from('tags').select('id,name,owner_type,owner_id,page_id').or(`page_id.eq.${p.id},owner_id.eq.${p.id}`).order('id')),db.from('contacts').select('id',{count:'exact',head:true}).eq('page_id',p.id)]);
 console.log(JSON.stringify({page:p.name,tags,contacts:counts.count},null,2));
 }
}

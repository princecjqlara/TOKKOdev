import fs from 'node:fs';
import path from 'node:path';
import nextEnv from '@next/env';
import {createClient} from '@supabase/supabase-js';
nextEnv.loadEnvConfig(process.cwd());
const out=path.resolve('analysis-output/onset-2026-09-17');
fs.mkdirSync(path.join(out,'messages'),{recursive:true});
const db=createClient(process.env.NEXT_PUBLIC_SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
const {data:page,error}=await db.from('pages').select('id,name,fb_page_id,access_token').eq('fb_page_id','699579919911250').single();
if(error)throw new Error(error.message);
async function all(query){const rows=[];for(let n=0;;n+=500){const r=await query().range(n,n+499);if(r.error)throw new Error(r.error.message);rows.push(...r.data);if(r.data.length<500)return rows;}}
async function graph(input){
 const url=new URL(input);if(url.hostname!=='graph.facebook.com')throw new Error('Unexpected pagination host');url.searchParams.delete('access_token');
 for(let i=0;i<4;i++){
  const r=await fetch(url,{headers:{Authorization:'Bearer '+page.access_token},signal:AbortSignal.timeout(30000)});
  const j=await r.json();if(r.ok&&!j.error)return j;
  if(i===3||(!j.error?.is_transient&&r.status!==429&&r.status<500))throw new Error(j.error?.message||String(r.status));
  await new Promise(resolve=>setTimeout(resolve,1000*2**i));
 }
}
const contacts=await all(()=>db.from('contacts').select('id,psid,name').eq('page_id',page.id).order('id'));
const tags=await all(()=>db.from('contact_tags').select('contact_id,tag_id,tags(name),contacts!inner(page_id)').eq('contacts.page_id',page.id).order('id'));
fs.writeFileSync(path.join(out,'contacts.json'),JSON.stringify(contacts));
fs.writeFileSync(path.join(out,'tags.json'),JSON.stringify(tags));
let url=`https://graph.facebook.com/v21.0/${page.fb_page_id}/conversations?fields=id,participants,updated_time&limit=100`;
const conversations=[],seen=new Set();
while(url){if(seen.has(url))throw new Error('Repeated conversation cursor');seen.add(url);const j=await graph(url);conversations.push(...(j.data||[]));url=j.paging?.next;}
fs.writeFileSync(path.join(out,'conversations.json'),JSON.stringify(conversations));
console.log(JSON.stringify({contacts:contacts.length,conversations:conversations.length}));
let index=0,done=0;const errors=[];
async function worker(){while(index<conversations.length){const c=conversations[index++],file=path.join(out,'messages',encodeURIComponent(c.id)+'.json');
 try{
  if(!fs.existsSync(file)){
   let next=`https://graph.facebook.com/v21.0/${c.id}/messages?fields=id,message,from,created_time&limit=100`;
   const messages=[],cursors=new Set();
   while(next){if(cursors.has(next))throw new Error('Repeated message cursor');cursors.add(next);const j=await graph(next);messages.push(...(j.data||[]));next=j.paging?.next;}
   fs.writeFileSync(file,JSON.stringify({id:c.id,participants:c.participants,updated_time:c.updated_time,fetchedAt:new Date().toISOString(),messages}));
  }
 }catch(e){errors.push({id:c.id,error:e.message});}
 done++;if(done%50===0)console.log(JSON.stringify({done,total:conversations.length,errors:errors.length}));
}}
await Promise.all(Array.from({length:6},worker));
fs.writeFileSync(path.join(out,'errors.json'),JSON.stringify(errors,null,2));
console.log(JSON.stringify({complete:true,done,errors:errors.length,out}));

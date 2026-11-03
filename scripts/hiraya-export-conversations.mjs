import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { once } from 'node:events';
import nextEnv from '@next/env';
import { createClient } from '@supabase/supabase-js';

nextEnv.loadEnvConfig(process.cwd());
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {auth:{persistSession:false,autoRefreshToken:false}});
const root = path.join(os.homedir(), 'Downloads', 'Hiraya-Studio-Conversations-2026-10-05');
fs.mkdirSync(path.join(root, 'raw', 'messages'), {recursive:true});
const startedAt = fs.statSync(root).birthtime.toISOString();
const save = (file, data) => {const target=path.join(root,file);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target+'.tmp',JSON.stringify(data));fs.renameSync(target+'.tmp',target);};
const read = file => JSON.parse(fs.readFileSync(path.join(root,file),'utf8'));
function clean(value) {
  if (typeof value === 'string') return value.replace(/([?&]access_token=)[^&\s"<>]+/gi,'$1REDACTED').replace(/EAA[A-Za-z0-9]{30,}/g,'REDACTED');
  if (Array.isArray(value)) return value.map(clean);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([k])=>!['access_token','paging'].includes(k)).map(([k,v])=>[k,clean(v)]));
  return value;
}
async function all(query) {const rows=[];for(let n=0;;n+=500){let r;for(let attempt=0;attempt<4;attempt++){r=await query().range(n,n+499);if(!r.error)break;if(attempt===3)throw new Error(r.error.message);await new Promise(r=>setTimeout(r,1000*2**attempt));}rows.push(...r.data);if(r.data.length<500)return rows;}}
let requests=0, retries=0;
async function graph(page, input) {
  const url = new URL(input);if(url.hostname!=='graph.facebook.com'||url.protocol!=='https:')throw new Error('Unexpected API pagination host');url.searchParams.delete('access_token');
  for(let attempt=0;attempt<7;attempt++) {
    let r,j;
    const controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),45000);
    try {requests++;r=await fetch(url,{headers:{Authorization:'Bearer '+page.access_token},signal:controller.signal});j=await r.json();}
    catch(e){if(attempt===6)throw new Error(clean(e.message));retries++;await new Promise(r=>setTimeout(r,Math.min(30000,1000*2**attempt)));continue;}
    finally {clearTimeout(timeout);}
    if(r.ok&&!j.error)return j;
    const retryable=j.error?.is_transient||[4,17,32,613].includes(j.error?.code)||r.status===429||r.status>=500;
    if(!retryable||attempt===6)throw new Error(clean(`Facebook ${j.error?.code||r.status}: ${j.error?.message||r.statusText}`));
    retries++;await new Promise(r=>setTimeout(r,Math.min(30000,2000*2**attempt)));
  }
}
const base='https://graph.facebook.com/v21.0';
const {data:pages,error}=await db.from('pages').select('id,name,fb_page_id,access_token,last_synced_at').ilike('name','%hiraya%');
if(error)throw new Error(error.message);if(!pages.length)throw new Error('No matching connected pages');
const candidates=[];
for(const p of pages) {
  const file=`raw/list-${p.fb_page_id}.json`;
  let state=fs.existsSync(path.join(root,file))?read(file):{conversations:[],complete:false,cursor:null};
  let url=state.complete?null:`${base}/${p.fb_page_id}/conversations?fields=id,participants,updated_time&limit=100`+(state.cursor?`&after=${encodeURIComponent(state.cursor)}`:'');
  const ids=new Set(state.conversations.map(c=>c.id)), seen=new Set();
  while(url){if(seen.has(url))throw new Error('Repeated conversation list cursor');seen.add(url);const j=await graph(p,url);for(const c of j.data||[]){if(!ids.has(c.id)){ids.add(c.id);state.conversations.push(clean(c));}}url=j.paging?.next;state.cursor=j.paging?.cursors?.after||null;state.complete=!url;save(file,state);if(state.conversations.length%500===0||!url)console.log(JSON.stringify({stage:'listing',page:p.name,conversations:state.conversations.length,complete:state.complete}));}
  const count=await db.from('contacts').select('id',{count:'exact',head:true}).eq('page_id',p.id);if(count.error)throw new Error(count.error.message);
  candidates.push({id:p.id,name:p.name,fb_page_id:p.fb_page_id,storedContacts:count.count,liveConversations:state.conversations.length});
}
candidates.sort((a,b)=>b.liveConversations-a.liveConversations||b.storedContacts-a.storedContacts);
save('page-comparison.json',candidates);
const selected=candidates[0], page=pages.find(p=>p.id===selected.id);
console.log(JSON.stringify({stage:'selected',...selected,root}));
const contacts=await all(()=>db.from('contacts').select('*').eq('page_id',page.id).order('psid'));
save('raw/contacts.json',clean(contacts));
const contactMap=new Map(contacts.map(c=>[c.psid,c]));
let conversations=read(`raw/list-${page.fb_page_id}.json`).conversations;
const folderCounts=[];
const folderMap=new Map(conversations.map(c=>[c.id,c]));
for(const folder of ['inbox','other','page_done','spam','archived']) {
  const file=`raw/folder-${folder}.json`;
  const state=fs.existsSync(path.join(root,file))?read(file):{folder,conversations:[],complete:false,cursor:null};
  let url=state.complete?null:`${base}/${page.fb_page_id}/conversations?folder=${folder}&fields=id,participants,updated_time&limit=100`+(state.cursor?`&after=${encodeURIComponent(state.cursor)}`:'');
  const ids=new Set(state.conversations.map(c=>c.id)),seen=new Set();
  while(url){if(seen.has(url))throw new Error('Repeated folder cursor');seen.add(url);const j=await graph(page,url);for(const c of j.data||[])if(!ids.has(c.id)){ids.add(c.id);state.conversations.push(clean(c));}url=j.paging?.next;state.cursor=j.paging?.cursors?.after||null;state.complete=!url;save(file,state);if(state.conversations.length%500===0||!url)console.log(JSON.stringify({stage:'folder-listing',folder,conversations:state.conversations.length,complete:state.complete}));}
  let added=0;for(const c of state.conversations){if(!folderMap.has(c.id))added++;folderMap.set(c.id,c);}
  folderCounts.push({folder,conversations:state.conversations.length,added});
}
conversations=[...folderMap.values()];save('folder-coverage.json',folderCounts);
// Look up stored contacts missing from the live page list, so older threads are not silently omitted.
const participantIds=new Set(conversations.flatMap(c=>(c.participants?.data||[]).map(p=>p.id)));
const missing=contacts.filter(c=>c.psid&&!participantIds.has(c.psid));
let lookups=fs.existsSync(path.join(root,'raw/contact-lookups.json'))?read('raw/contact-lookups.json'):{};
const unavailableContactError=message=>/No matching user found|thread owner has archived or deleted|thread does not exist/i.test(message||'');
for(const entry of Object.values(lookups))if(!entry.complete&&unavailableContactError(entry.error)){entry.complete=true;entry.unavailableReason=entry.error;entry.conversations=[];delete entry.error;}
let lookupIndex=0;const lookupErrors=[];
async function lookupWorker(){while(lookupIndex<missing.length){const c=missing[lookupIndex++];if(lookups[c.psid]?.complete)continue;if(lookups[c.psid]?.error&&process.env.HIRAYA_RETRY_LOOKUPS!=='1'){lookupErrors.push({psid:c.psid,error:lookups[c.psid].error});continue;}try{let url=`${base}/${page.fb_page_id}/conversations?user_id=${encodeURIComponent(c.psid)}&fields=id,participants,updated_time&limit=100`,data=[],seen=new Set();while(url){if(seen.has(url))throw new Error('Repeated contact lookup cursor');seen.add(url);const j=await graph(page,url);data.push(...(j.data||[]));url=j.paging?.next;}lookups[c.psid]={complete:true,conversations:clean(data)};}catch(e){if(unavailableContactError(e.message)){lookups[c.psid]={complete:true,conversations:[],unavailableReason:e.message};}else{lookups[c.psid]={complete:false,error:e.message};lookupErrors.push({psid:c.psid,error:e.message});}}if(lookupIndex%100===0){save('raw/contact-lookups.json',lookups);console.log(JSON.stringify({stage:'older-contact-lookups',done:lookupIndex,total:missing.length,errors:lookupErrors.length}));}}}
await Promise.all(Array.from({length:6},lookupWorker));save('raw/contact-lookups.json',lookups);
const convMap=new Map(conversations.map(c=>[c.id,c]));for(const v of Object.values(lookups))for(const c of v.conversations||[])convMap.set(c.id,c);
conversations=[...convMap.values()];save('raw/conversations.json',conversations);
const fields='id,message,from,to,created_time,attachments,shares,sticker,tags';
async function expandEdges(value) {
  if(Array.isArray(value)){for(const v of value)await expandEdges(v);return;}
  if(!value||typeof value!=='object')return;
  if(Array.isArray(value.data)&&value.paging?.next){let url=value.paging.next;const seen=new Set(),ids=new Set(value.data.map(v=>v.id).filter(Boolean));while(url){if(seen.has(url)){value.paginationNote='Facebook returned a repeated edge cursor; all distinct entries retained.';break;}seen.add(url);const j=await graph(page,url);let added=0;for(const v of j.data||[]){if(!v.id||!ids.has(v.id)){value.data.push(v);added++;if(v.id)ids.add(v.id);}}if(!added){if(j.data?.length)value.paginationNote='Facebook returned duplicate edge entries with a next link; all distinct entries retained.';break;}url=j.paging?.next;}delete value.paging;}
  for(const [k,v] of Object.entries(value))if(k!=='paging')await expandEdges(v);
}
let index=0,done=0,messageCount=0,lastLog=Date.now();const fetchErrors=[];
async function fetchWorker(){while(index<conversations.length){const c=conversations[index++],file=`raw/messages/${encodeURIComponent(c.id)}.json`;let state=fs.existsSync(path.join(root,file))?read(file):{conversation:clean(c),messages:[],complete:false,cursor:null,fields};
  try {if(!state.complete){let url=`${base}/${c.id}/messages?fields=${encodeURIComponent(fields)}&limit=100`+(state.cursor?`&after=${encodeURIComponent(state.cursor)}`:'');const seen=new Set(),ids=new Set(state.messages.map(m=>m.id));while(url){if(seen.has(url))throw new Error('Repeated message cursor');seen.add(url);const j=await graph(page,url);for(const m of j.data||[])if(!ids.has(m.id)){await expandEdges(m);ids.add(m.id);state.messages.push(clean(m));}url=j.paging?.next;state.cursor=j.paging?.cursors?.after||null;state.complete=!url;state.fetchedAt=new Date().toISOString();save(file,state);}}
  }catch(e){state.error=e.message;save(file,state);fetchErrors.push({conversationId:c.id,error:e.message,retainedMessages:state.messages.length});}
  done++;messageCount+=state.messages.length;if(Date.now()-lastLog>20000||done===conversations.length){lastLog=Date.now();console.log(JSON.stringify({stage:'messages',done,total:conversations.length,messages:messageCount,errors:fetchErrors.length,requests,retries}));}
}}
if(process.env.HIRAYA_COMPILE_ONLY==='1') {done=conversations.length;messageCount=Number(process.env.HIRAYA_EXPECTED_MESSAGES);if(!Number.isSafeInteger(messageCount)||messageCount<1)throw new Error('Expected message count required for compile-only mode');}
else await Promise.all(Array.from({length:64},fetchWorker));
save('errors.json',{contactLookupErrors:lookupErrors,messageFetchErrors:fetchErrors});
console.log(JSON.stringify({stage:'compile',conversations:conversations.length,messages:messageCount}));
const txt=fs.createWriteStream(path.join(root,'ALL-CONVERSATIONS.txt'),{encoding:'utf8',highWaterMark:2*1024*1024});
const json=fs.createWriteStream(path.join(root,'ALL-CONVERSATIONS.json'),{encoding:'utf8',highWaterMark:2*1024*1024});
async function write(stream,s){if(!stream.write(s))await once(stream,'drain');}
const header={page:selected,startedAt,completedAt:new Date().toISOString(),timezone:'Asia/Manila',messageFields:fields.split(','),scope:'All conversations returned by Facebook, with explicit inbox, other, page_done, spam, and archived folder queries and lookups for stored contacts absent from those lists.',folderCounts,attachmentScope:'Attachment metadata and available URLs; media binaries are not downloaded.',pageComparison:candidates};
await write(txt,`${page.name} — COMPLETE AVAILABLE FACEBOOK CONVERSATION EXPORT\nFacebook Page ID: ${page.fb_page_id}\nExport started: ${startedAt}\nConversations: ${conversations.length}\nMessages: ${messageCount}\nTimes below are Asia/Manila; original timestamps are preserved in JSON.\nAttachment metadata and available URLs are included.\n\n`);
await write(json,'{"metadata":'+JSON.stringify(header)+',"conversations":[\n');
const convIndex=[];let first=true,oldest=null,newest=null,attachments=0,unnamed=0,verifiedMessages=0,completeThreads=0;
const timeFormatter=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Manila',dateStyle:'medium',timeStyle:'medium',hour12:false});
const formatTime=t=>{const d=new Date(t);return Number.isNaN(d.getTime())?String(t||'Unknown time'):timeFormatter.format(d)+' PHT';};
for(const c of conversations){const state=read(`raw/messages/${encodeURIComponent(c.id)}.json`);const participants=(c.participants?.data||[]).map(p=>({...p,storedContact:contactMap.has(p.id)?clean(contactMap.get(p.id)):undefined}));const clients=participants.filter(p=>p.id!==page.fb_page_id);const names=clients.map(p=>p.name||p.storedContact?.name||`Unnamed (${p.id})`);if(clients.some(p=>!p.name&&!p.storedContact?.name))unnamed++;
  const messages=state.messages.sort((a,b)=>Date.parse(a.created_time)-Date.parse(b.created_time)||String(a.id).localeCompare(String(b.id)));verifiedMessages+=messages.length;if(state.complete)completeThreads++;
  const record={...c,participants:{...c.participants,data:participants},contactNames:names,complete:state.complete,fetchedAt:state.fetchedAt,error:state.complete?undefined:state.error,messages};
  await write(json,(first?'':',\n')+JSON.stringify(record));first=false;
  let transcript=`${'='.repeat(90)}\n${names.join(' / ')||'No participant name available'}\nConversation ID: ${c.id}\nParticipants: ${participants.map(p=>`${p.name||p.storedContact?.name||'Unnamed'} (${p.id})`).join('; ')}\nLast updated: ${formatTime(c.updated_time)}\nMessages: ${messages.length}; retrieval: ${state.complete?'complete':'PARTIAL — '+state.error}\n${'-'.repeat(90)}\n`;
  for(const m of messages){const sender=m.from?.name||contactMap.get(m.from?.id)?.name||m.from?.id||'Unknown sender';const direction=m.from?.id===page.fb_page_id?'PAGE → CONTACT':'CONTACT → PAGE';transcript+=`[${formatTime(m.created_time)}] ${sender} | ${direction}\nMessage ID: ${m.id}\n${m.message||'[No text]'}\n`;const extra=Object.fromEntries(['attachments','shares','sticker','tags'].filter(k=>m[k]!==undefined).map(k=>[k,m[k]]));if(m.attachments?.data?.length||m.shares?.data?.length||m.sticker)attachments++;if(Object.keys(extra).length)transcript+=`Additional message data: ${JSON.stringify(extra)}\n`;transcript+='\n';if(m.created_time&&Number.isFinite(Date.parse(m.created_time))){if(!oldest||Date.parse(m.created_time)<Date.parse(oldest))oldest=m.created_time;if(!newest||Date.parse(m.created_time)>Date.parse(newest))newest=m.created_time;}}
  await write(txt,transcript);
  convIndex.push({conversationId:c.id,contactNames:names,participantIds:clients.map(p=>p.id),messageCount:messages.length,updatedTime:c.updated_time,complete:state.complete});
}
await write(json,'\n]}\n');txt.end();json.end();await Promise.all([once(txt,'finish'),once(json,'finish')]);
save('conversation-index.json',convIndex);
const manifest={...header,conversationCount:conversations.length,completeConversations:completeThreads,messageCount:verifiedMessages,contacts:contacts.length,contactsAbsentFromLiveList:missing.length,contactsWithoutAvailableThread:missing.filter(c=>lookups[c.psid]?.complete&&!lookups[c.psid].conversations?.length).length,conversationsWithoutNames:unnamed,messagesWithAttachmentOrShareOrSticker:attachments,oldestMessage:oldest,newestMessage:newest,contactLookupErrors:lookupErrors.length,messageFetchErrors:fetchErrors.length,requests,retries,files:['ALL-CONVERSATIONS.txt','ALL-CONVERSATIONS.json','conversation-index.json','page-comparison.json','errors.json','raw/contacts.json','raw/conversations.json','raw/messages/'],limitations:['Only information exposed to the connected Facebook app at export time can be collected.','Deleted, unsent, inaccessible messages and threads are not recoverable.','Attachment URLs may expire; media binaries are not downloaded.','Pagination represents a live collection and is not an atomic snapshot.']};
save('EXPORT-SUMMARY.json',manifest);
fs.writeFileSync(path.join(root,'README.txt'),`${page.name} conversation archive\n\nOpen ALL-CONVERSATIONS.txt for the readable compilation.\nALL-CONVERSATIONS.json preserves all returned message fields, names, participant IDs, attachment metadata, and associated stored contact details.\nconversation-index.json lists each conversation and message count.\nraw/messages contains a checkpointed file for every conversation.\n\nConversations: ${conversations.length}\nMessages: ${verifiedMessages}\nComplete conversation fetches: ${completeThreads}\nMessage fetch errors: ${fetchErrors.length}\nContact lookup errors: ${lookupErrors.length}\nDate range: ${oldest} to ${newest}\n\nSelected page: ${page.name} (${page.fb_page_id})\nSelection: most conversations in the live comparison.\n${candidates.map(p=>`${p.name} (${p.fb_page_id}): ${p.liveConversations} live conversations; ${p.storedContacts} stored contacts`).join('\n')}\n\n${manifest.limitations.join('\n')}\n`);
if(verifiedMessages!==messageCount)throw new Error('Compiled message count mismatch');
console.log(JSON.stringify({stage:'finished',root,...manifest}));

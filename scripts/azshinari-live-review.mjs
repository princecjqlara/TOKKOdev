import fs from 'node:fs';
import path from 'node:path';
const out=path.resolve('analysis-output/azshinari-2026-09-15');
const contacts=JSON.parse(fs.readFileSync(path.join(out,'contacts.json')));const tags=JSON.parse(fs.readFileSync(path.join(out,'tags-before.json')));
const byPsid=new Map(contacts.map(c=>[c.psid,c]));const byId=new Map();for(const t of tags){if(!byId.has(t.contact_id))byId.set(t.contact_id,[]);byId.get(t.contact_id).push(t);}
const records=[];
for(const file of fs.readdirSync(path.join(out,'messages'))){
const raw=JSON.parse(fs.readFileSync(path.join(out,'messages',file),'utf8'));
const participant=raw.participants?.data?.find(p=>p.id!=='656646850875530');const c=byPsid.get(participant?.id);
records.push({psid:participant?.id||'',contactId:c?.id||'',name:c?.name||participant?.name||'',conversationId:raw.conversationId,tags:byId.get(c?.id)||[],paidTag:(byId.get(c?.id)||[]).some(t=>t.tag_id==='312cb4e3-e221-42df-9d03-742de5e2bbc8'),messages:raw.messages.map(m=>({id:m.id,date:m.created_time,sender:m.from?.id==='656646850875530'?'page':m.from?.id===participant?.id?'contact':'unknown',text:m.message||''})).sort((a,b)=>a.date.localeCompare(b.date))});
}
records.sort((a,b)=>a.psid.localeCompare(b.psid));fs.writeFileSync(path.join(out,'live-records.json'),JSON.stringify(records));
const freq=new Map();for(const r of records)for(const m of r.messages)if(m.text)freq.set(m.text,(freq.get(m.text)||0)+1);
const re=/\b(paid|nagbayad|binayaran|nakapagbayad|payment.*(?:sent|done|received|receive|confirmed)|(?:sent|done|received|receive|confirmed).*payment|bayad na|na.*bayad|already sent|sent na|na ?send ko na|nasend na|na ?receive|nareceive|receipt|resibo|availed|inavail|final output|final video|revision|revised|watermark|received|remaining balance)\b/i;
const candidates=records.filter(r=>r.paidTag||r.messages.some(m=>re.test(m.text)&&(m.sender==='contact'||freq.get(m.text)<6)));
fs.writeFileSync(path.join(out,'live-candidates.json'),JSON.stringify(candidates));
console.log(JSON.stringify({liveConversations:records.length,messages:records.reduce((n,r)=>n+r.messages.length,0),candidates:candidates.length,alreadyPaidTagged:records.filter(r=>r.paidTag).length}));
if(process.argv[2]==='index')console.log(candidates.map((r,i)=>`${i}|${r.name}|${r.psid}|${r.paidTag}|${r.messages.length}`).join('\n'));
if(['evidence','pending'].includes(process.argv[2])){
const decisions=JSON.parse(fs.readFileSync(path.join(out,'review-decisions.json')));
const queue=process.argv[2]==='pending'?candidates.filter(r=>!r.paidTag&&!decisions[r.psid]):candidates;
console.log('Queue size: '+queue.length);
for(const r of queue.slice(Number(process.argv[3]||0),Number(process.argv[4]||20))){
console.log(`\n### ${r.name} | ${r.psid} | paid=${r.paidTag} | tags=${r.tags.length} | ${r.messages.length} messages`);
const selected=new Set();r.messages.forEach((m,i)=>{if(re.test(m.text)&&(m.sender==='contact'||freq.get(m.text)<6)){for(let j=Math.max(0,i-1);j<=Math.min(r.messages.length-1,i+1);j++)selected.add(j);}});
for(const i of [...selected].sort((a,b)=>a-b)){const m=r.messages[i];console.log(`${i} ${m.date.slice(0,10)} ${m.sender}: ${m.text.replace(/\n/g,' | ').slice(0,700)}`);}
}}
if(process.argv[2]==='contact'){
for(const r of records.filter(r=>process.argv.slice(3).includes(r.psid))){console.log(`\n### ${r.name} | ${r.psid}`);r.messages.forEach((m,i)=>{if(m.text)console.log(`${i} ${m.date.slice(0,10)} ${m.sender}: ${m.text.replace(/\n/g,' | ')}`);});}}
if(process.argv[2]==='compact'){
for(const r of records.filter(r=>process.argv.slice(3).includes(r.psid))){console.log(`\n### ${r.name} | ${r.psid}`);r.messages.forEach((m,i)=>{if(m.text&&(m.sender==='contact'||freq.get(m.text)<3))console.log(`${i} ${m.date.slice(0,10)} ${m.sender}: ${m.text.replace(/\n/g,' | ').slice(0,450)}`);});}}

import fs from 'node:fs';
import path from 'node:path';
const out=path.resolve('analysis-output/azshinari-2026-09-15');
function parseCSV(s){const rows=[];let row=[],field='',q=false;for(let i=0;i<s.length;i++){const c=s[i];if(c==='"'){if(q&&s[i+1]==='"'){field+='"';i++;}else q=!q;}else if(c===','&&!q){row.push(field);field='';}else if(c==='\n'&&!q){row.push(field.replace(/\r$/,''));rows.push(row);row=[];field='';}else field+=c;}if(field||row.length){row.push(field);rows.push(row);}return rows;}
const contacts=JSON.parse(fs.readFileSync(path.join(out,'contacts.json')));const tags=JSON.parse(fs.readFileSync(path.join(out,'tags-before.json')));
const contactMap=new Map(contacts.map(c=>[c.psid,c]));const tagMap=new Map();for(const t of tags){if(!tagMap.has(t.contact_id))tagMap.set(t.contact_id,[]);tagMap.get(t.contact_id).push(t.tag_id);}
const records=new Map();const seen=new Set();let header;
for(const f of fs.readdirSync(path.join(out,'export-chunks')).sort()){
 const rows=parseCSV(fs.readFileSync(path.join(out,'export-chunks',f),'utf8')).filter(r=>r.length>1);if(!header)header=rows.shift();
 for(const row of rows){if(row.length!==header.length)throw new Error(`CSV shape ${f}: ${row.length}`);const m=Object.fromEntries(header.map((h,i)=>[h,row[i]]));if(seen.has(m.messageId))continue;seen.add(m.messageId);
 if(!records.has(m.contactPsid)){const c=contactMap.get(m.contactPsid);records.set(m.contactPsid,{psid:m.contactPsid,contactId:c?.id||'',name:c?.name||m.contactName||'',conversationId:m.conversationId,tags:tagMap.get(c?.id)||[],messages:[]});}
 const r=records.get(m.contactPsid);if(!r.name&&m.senderType==='contact')r.name=m.senderName;
 r.messages.push({id:m.messageId,date:m.sentAt,sender:m.senderType,text:m.message});
 }
}
const signal=/\b(paid|payment|bayad|nagbayad|binayaran|nakapagbayad|naipadala|nasend|na send|sent|receipt|resibo|deposit|downpayment|balance|availed|inavail|thank you.*(?:trust|avail)|salamat.*tiwala|final video|final output|revision|revise|revised|watermark)\b/i;
const list=[...records.values()];for(const r of list){r.messages.sort((a,b)=>a.date.localeCompare(b.date));r.signals=r.messages.map((m,i)=>signal.test(m.text)?i:-1).filter(i=>i>=0);r.paidTag=r.tags.includes('312cb4e3-e221-42df-9d03-742de5e2bbc8');}
fs.writeFileSync(path.join(out,'records.json'),JSON.stringify(list));
const candidates=list.filter(r=>r.signals.length||r.paidTag).sort((a,b)=>b.messages.length-a.messages.length);
fs.writeFileSync(path.join(out,'candidate-index.json'),JSON.stringify(candidates.map((r,i)=>({i,psid:r.psid,name:r.name,paid:r.paidTag,tags:r.tags.length,messages:r.messages.length,signals:r.signals.length})),null,2));
fs.writeFileSync(path.join(out,'review.txt'),candidates.map((r,i)=>`\n### ${i} ${r.name} | ${r.psid} | paid=${r.paidTag} | messages=${r.messages.length}\n`+r.messages.filter(m=>m.sender==='contact'&&m.text).map(m=>`${m.date.slice(0,10)} ${m.text.replace(/\n/g,' | ')}`).join('\n')).join('\n'));
console.log(JSON.stringify({conversations:list.length,messages:seen.size,candidates:candidates.length,paidInExport:list.filter(r=>r.paidTag).length}));
if(process.argv[2]==='index')console.log(fs.readFileSync(path.join(out,'candidate-index.json'),'utf8'));

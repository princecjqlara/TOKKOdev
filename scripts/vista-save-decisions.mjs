import fs from 'node:fs';const p='analysis-output/vista-2026-09-15/';const d=JSON.parse(fs.readFileSync(p+'review-decisions.json'));const rs=JSON.parse(fs.readFileSync(p+'live-records.json'));
const batch=JSON.parse(fs.readFileSync(p+'current-batch.json'));
for(const [id,idx,reason] of batch){const r=rs.find(r=>r.psid===id);if(!r||idx.some(i=>!r.messages[i]))throw Error('Invalid evidence '+id);d[id]={qualifies:true,evidenceIndexes:idx,reason:reason||'Credited deposit, payment acknowledgement or commissioned service; full payment not assumed'};}
fs.writeFileSync(p+'review-decisions.json',JSON.stringify(d,null,2));console.log({supported:Object.values(d).filter(x=>x.qualifies).length});

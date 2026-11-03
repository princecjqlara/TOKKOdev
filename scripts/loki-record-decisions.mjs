import fs from 'node:fs';const p='analysis-output/loki-2026-09-15/';const d=JSON.parse(fs.readFileSync(p+'review-decisions.json'));
const batches=JSON.parse(fs.readFileSync(p+'reviewed-batches.json'));
for(const [psid,evidenceIndexes,reason] of batches)d[psid]={qualifies:true,evidenceIndexes,reason:reason||'Documented deposit, credited final bill or commissioned service delivery; full payment is not assumed'};
fs.writeFileSync(p+'review-decisions.json',JSON.stringify(d,null,2));console.log({supported:Object.values(d).filter(v=>v.qualifies).length});

import fs from 'node:fs';
const dir='analysis-output/azshinari-2026-09-15/';const records=JSON.parse(fs.readFileSync(dir+'live-records.json'));
const decisions=JSON.parse(fs.readFileSync(dir+'review-decisions.json'));
const freq=new Map();for(const r of records)for(const m of r.messages)freq.set(m.text,(freq.get(m.text)||0)+1);
const mode=process.argv[2];let rows=records.filter(r=>process.argv.slice(3).includes(r.psid));
if(mode==='missing'){const details=JSON.parse(fs.readFileSync(dir+'client-details.json'));const ids=new Set(details.filter(r=>!r.forms.some(f=>Object.keys(f.fields).some(k=>/^business(?:\s*name)?$|company\s*name/i.test(k)))).map(r=>r.psid));rows=records.filter(r=>ids.has(r.psid)).slice(Number(process.argv[3]||0),Number(process.argv[4]||10));}
for(const r of rows){console.log(`\n### ${r.name}|${r.psid}|${r.messages.length} messages`);for(let i=0;i<r.messages.length;i++){const m=r.messages[i];if(!m.text)continue;
if(mode==='full')console.log(`${i} ${m.date.slice(0,10)} ${m.sender}: ${m.text}`);
else if(mode==='payment'){if(m.text.length<450&&(m.sender==='contact'||freq.get(m.text)<10))console.log(`${i} ${m.date.slice(0,10)} ${m.sender}: ${m.text.replace(/\n/g,' | ')}`);}
else if(mode==='missing'){if(m.sender==='contact'&&m.text.length>15&&!/^(?:magkano ang|paano mo|kailan ko|messenger automatically|you can call|how much|magkano po|ok po|yes po)/i.test(m.text))console.log(`${i} contact: ${m.text.replace(/\n/g,' | ').slice(0,950)}`);}
}}

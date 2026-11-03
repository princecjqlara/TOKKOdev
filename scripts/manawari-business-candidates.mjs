import fs from 'node:fs';
const p='analysis-output/manawari-2026-09-15/';const rs=JSON.parse(fs.readFileSync(p+'live-records.json'));const ds=JSON.parse(fs.readFileSync(p+'review-decisions.json'));const cs=JSON.parse(fs.readFileSync(p+'client-details.json'));const ss=JSON.parse(fs.readFileSync(p+'business-supplements.json'));
const output=[];
for(const c of cs.filter(c=>ds[c.psid]?.qualifies)){
 const r=rs.find(r=>r.psid===c.psid);
 const named=c.forms.some(f=>Object.entries(f.fields).some(([k,v])=>/^business(?:\s*name)?$|company\s*name/i.test(k)&&v.trim()&&!/^po |lang po|n\/a|none|wala/i.test(v)));
 if(named||ss.some(s=>s.psid===c.psid&&s.business))continue;
 const incoming=r.messages.map((m,i)=>({...m,i})).filter(m=>m.sender==='contact'&&m.text.trim());
 const candidates=incoming.filter(m=>m.text.length>40&&!/^Messenger|^You can|^https?:\/\/[^\s]+$/i.test(m.text)&&(/business|location|address|\bshop\b|\bstore\b|\bservices\b|\bcompany\b|\bname\b|contact|\n.*\n.*\n/i.test(m.text)));
 output.push({psid:c.psid,name:c.name,candidates});
}
fs.writeFileSync(p+'business-candidates.json',JSON.stringify(output));console.log('Missing business names '+output.length);
for(const r of output.slice(+process.argv[2]||0,+process.argv[3]||25)){console.log('\n'+r.psid+'|'+r.name);for(const m of [...r.candidates.slice(0,3),...r.candidates.slice(-2)].filter((m,i,a)=>a.findIndex(x=>x.i===m.i)===i))console.log(m.i+' '+m.text.replace(/\n/g,' | ').slice(0,700));}

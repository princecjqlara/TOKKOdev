import fs from 'node:fs';const p='analysis-output/vista-2026-09-15/';const rs=JSON.parse(fs.readFileSync(p+'live-records.json'));const ds=JSON.parse(fs.readFileSync(p+'review-decisions.json'));
const rows=[];
for(const r of rs){if(ds[r.psid])continue;const ev=[];
 r.messages.forEach((m,i)=>{const t=m.text;if(m.sender==='page'&&t.length<1500&&/final pay|breakdown|final payment|package availed/i.test(t)&&/(?:Down\s*Payment|DP)(?:\s*fee)?\s*:\s*(?:PHP|P|₱)?\s*[1-9]/i.test(t)&&/Balance(?:\s*to\s*pay)?\s*:\s*(?:PHP|P|₱)?\s*[\d_]/i.test(t)&&!/(?:you can try|starter pack|before:|free inclusions|step.by.step|PRICE LIST|VIDEO PACKAGES)/i.test(t))ev.push({i,text:t});});
 if(ev.length)rows.push({psid:r.psid,name:r.name,existing:r.paidTag,evidence:ev,warnings:r.messages.map((m,i)=>({...m,i})).filter(m=>m.sender==='contact'&&m.text.length<500&&/cancel|refund|hindi.*(?:bayad|nag.?down)|di.*(?:ituloy|tutuloy)|not.*(?:paid|pay)|misdeal/i.test(m.text)).map(m=>({i:m.i,text:m.text}))});
}
fs.writeFileSync(p+'bill-candidates.json',JSON.stringify(rows));console.log('BILL CANDIDATES '+rows.length);
for(const r of rows.slice(+process.argv[2]||0,+process.argv[3]||50)){console.log('\n'+r.psid+'|'+r.name+'|old='+r.existing);for(const e of [r.evidence[0],r.evidence.at(-1)].filter((x,i,a)=>a.findIndex(y=>y.i===x.i)===i))console.log(e.i+' '+e.text.replace(/Final pay(?:ment)?[^\n]*(?:\n|$)|Pasend[^]*|GCASH[^]*/gi,'').replace(/\s*\n\s*/g,' | ').slice(0,500));for(const w of r.warnings)console.log('CHECK '+w.i+' '+w.text.slice(0,400));}

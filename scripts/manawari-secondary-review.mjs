import fs from 'node:fs';
const dir='analysis-output/manawari-2026-09-15/';const records=JSON.parse(fs.readFileSync(dir+'live-records.json'));const decisions=JSON.parse(fs.readFileSync(dir+'review-decisions.json'));
const freq=new Map();for(const r of records)for(const m of r.messages){for(const u of m.text.match(/https:\/\/drive\.google\.com\/[^\s]+/g)||[])freq.set(u,(freq.get(u)||0)+1);}
const rows=[];
for(const r of records){if(decisions[r.psid]?.qualifies)continue;const ev=[];r.messages.forEach((m,i)=>{const t=m.text;const prev=r.messages.slice(Math.max(0,i-10),i).filter(m=>m.text).map(m=>m.text).join(' | ');
if(m.sender==='page'&&t.length<150&&/^(?:na ?)?received(?: na| napo| po| sir| ma|$)|^nareceive (?:ko|na|po)/i.test(t)&&/gcash|receipt|payment|bayad|balance|\bdp\b|downpayment|down payment|resibo/i.test(prev))ev.push({i,type:'Receipt acknowledged near payment discussion',text:prev.slice(-750)+' >> '+t});
else if(m.sender==='page'&&/You (?:marked|confirmed).*paid|Lead stage set to Converted/i.test(t))ev.push({i,type:'Conversion event',text:prev.slice(-1000)+' >> '+t});
else if(m.sender==='page'&&t.length<500&&/(?:tapos|done|naayos|ready na|eto na|ito na|here na).*?(?:video|file|output)|(?:video|file|output).*?(?:tapos|done|ready na)/i.test(t)&&!/(?:sample|pwede|kaya.*today|kaya.*tapos|same day|if |kung |once|kapag|bukas|tomorrow|within|quick reminder|just checking|ready na po ba|\?)/i.test(t)){
 const window=r.messages.slice(Math.max(0,i-5),i+6);if(window.some(x=>(x.text.match(/https:\/\/drive\.google\.com\/[^\s]+/g)||[]).some(u=>freq.get(u)<10)))ev.push({i,type:'Produced output with specific delivery link',text:t+' >> '+window.filter(x=>x.sender==='contact'&&x.text).map(x=>x.text).join(' | ').slice(0,500)});
}
});if(ev.length)rows.push({...r,evidence:ev});}
fs.writeFileSync(dir+'secondary-candidates.json',JSON.stringify(rows));console.log(`SECONDARY ${rows.length}`);for(const r of rows.slice(Number(process.argv[2]||0),Number(process.argv[3]||30))){console.log(`\n${r.psid}|${r.name}|${r.messages.length} msgs`);for(const e of r.evidence.slice(0,2))console.log(`${e.i} ${r.messages[e.i].date.slice(0,10)} ${e.type}: ${e.text}`);}

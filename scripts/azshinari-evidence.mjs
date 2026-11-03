import fs from 'node:fs';
const root='analysis-output/azshinari-2026-09-15/';
const records=JSON.parse(fs.readFileSync(root+'records.json'));
const freq=new Map();for(const r of records)for(const m of r.messages)if(m.text)freq.set(m.text,(freq.get(m.text)||0)+1);
const re=/\b(paid|nagbayad|binayaran|nakapagbayad|payment.*(?:sent|done|received|receive|confirmed)|(?:sent|done|received|receive|confirmed).*payment|bayad na|na.*bayad|already sent|sent na|na ?send ko na|nasend na|na ?receive|nareceive|receipt|resibo|availed|inavail|final output|final video|revision|revised|watermark)\b/i;
const candidates=records.filter(r=>r.paidTag||r.messages.some(m=>re.test(m.text)&&(m.sender==='contact'||freq.get(m.text)<6)));
fs.writeFileSync(root+'strong-candidates.json',JSON.stringify(candidates));
const start=Number(process.argv[2]||0),end=Number(process.argv[3]||40);
console.log(`TOTAL ${candidates.length}`);
for(let k=start;k<Math.min(end,candidates.length);k++){const r=candidates[k];console.log(`\n### ${k} ${r.name} | ${r.psid} | tagged=${r.paidTag} | ${r.messages.length} messages`);const selected=new Set();r.messages.forEach((m,i)=>{if(re.test(m.text)&&(m.sender==='contact'||freq.get(m.text)<6)){for(let j=Math.max(0,i-1);j<=Math.min(r.messages.length-1,i+1);j++)selected.add(j);}});for(const i of [...selected].sort((a,b)=>a-b)){const m=r.messages[i];console.log(`${i} ${m.date.slice(0,10)} ${m.sender}: ${m.text.replace(/\n/g,' | ').slice(0,850)}`);}}

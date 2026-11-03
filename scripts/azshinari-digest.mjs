import fs from 'node:fs';
const dir='analysis-output/azshinari-2026-09-15/';
const records=JSON.parse(fs.readFileSync(dir+'live-records.json'));
const decisions=JSON.parse(fs.readFileSync(dir+'review-decisions.json'));
const found=[];
for(const r of records){if(r.paidTag||decisions[r.psid])continue;
const evidence=[];
r.messages.forEach((m,i)=>{
const t=m.text;
const dp=t.match(/Down\s*Payment\s*:\s*(?:₱|PHP)?\s*([\d,]+(?:\.\d+)?)/i);
const bal=t.match(/Remaining\s*Balance\s*:\s*(?:₱|PHP)?\s*([\d,]+(?:\.\d+)?)/i);
if(m.sender==='page'&&dp&&bal&&Number(dp[1].replaceAll(',',''))>0&&/final payment|final output/i.test(t))evidence.push({i,type:'Personalized final bill credits deposit',text:t.replace(/\n/g,' | ')});
else if(m.sender==='page'&&t.length<300&&/(?:you confirmed that .*made a payment|fully paid (?:ka|na kayo)|paid na (?:po ito|po kayo)|(?:na ?receive|nareceive).*(?:down ?payment|payment ni)|payment (?:received|confirmed))/i.test(t)&&!/(?:once|kapag|pag na|if |kung|bago)/i.test(t))evidence.push({i,type:'Page confirms payment',text:t});
else if(m.sender==='contact'&&t.length<250&&/(?:\bpaid na|\bbayad na (?:ko|ako)|nabayaran ko na|payment (?:done|sent)|done (?:dp|payment)|nakapagdown (?:na|nako)|nagbayad na|nakapagbayad na)/i.test(t))evidence.push({i,type:'Client confirms payment',text:t});
else if(m.sender==='page'&&t.length<250&&/(?:here|eto|ito).*?(?:video|copy).*?(?:without watermark|walang watermark)/i.test(t)&&!/(?:once|kapag|if |kung|bago|muna|after|pag ?nag|sample)/i.test(t))evidence.push({i,type:'Final output delivered',text:t});
});
if(evidence.length)found.push({...r,evidence});}
fs.writeFileSync(dir+'digest-candidates.json',JSON.stringify(found));
console.log(`STRONG PENDING ${found.length}`);
for(const r of found.slice(Number(process.argv[2]||0),Number(process.argv[3]||50))){console.log(`\n${r.psid} | ${r.name} | tags=${r.tags.length} | ${r.messages.length} msgs`);for(const e of r.evidence.slice(0,2))console.log(`${e.i} ${r.messages[e.i].date.slice(0,10)} ${e.type}: ${e.text.slice(0,700)}`);}

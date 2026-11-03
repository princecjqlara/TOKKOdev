import fs from 'node:fs';const p='analysis-output/manawari-2026-09-15/';const rs=JSON.parse(fs.readFileSync(p+'live-records.json'));const ds=JSON.parse(fs.readFileSync(p+'review-decisions.json'));
const linkFreq=new Map();for(const r of rs)for(const m of r.messages)for(const u of m.text.match(/https:\/\/drive\.google\.com\/[^\s]+/g)||[])linkFreq.set(u,(linkFreq.get(u)||0)+1);
const rows=[];
for(const r of rs){if(ds[r.psid])continue;const ev=[];
 for(let i=0;i<r.messages.length;i++){const m=r.messages[i],t=m.text;let type='';
  if(m.sender==='page'&&/AI COMMERCIAL VIDEO PACKAGES|PROMO PRICE|PRICE LIST|BATCH SALE|FREE INCLUSIONS|bonus videos can be used|STEP.BY.STEP|150 dp lang|150pesos dp|₱150 DP|remaining balance.*(?:after namin|pag natapos|kapag)/i.test(t)&&!/package availed|breakdown|final pay po muna/i.test(t))continue;
  if(m.sender==='contact'&&/download/i.test(t))continue;
  if(m.sender==='page'&&/confirmed that.*made a payment|payment (?:received|confirmed)|(?:since|dahil).*?(?:paid|nag.?down|nakapag.?down)|Down\s*Payment\s*:\s*(?:₱|PHP)?\s*[1-9]/i.test(t)&&t.length<1200)type='Payment / deposit statement';
  else if(m.sender==='contact'&&t.length<400&&/fully paid|paid na|done (?:payment|dp)|payment (?:done|sent)|nag ?pay|nag ?down|ngdown|nakapag ?pay|nakapag ?down|nagbayad|binayad|nabayaran|na.?send.*(?:balance|payment)|(?:nag ?send|sent).*?(?:gcash|dp|balance)|proof of payment|receipt|resibo|confirm receipt|na send ko na\s*\d/i.test(t))type='Client payment statement / question';
  else if(m.sender==='page'&&t.length<500&&/original (?:copy|video)|final(?:ized)? (?:video|output)|clear copy|without watermark|walang watermark|remaining balance|nalang po.*balance|balance.*nalang|nag down na po|na.less.*dp|\d.*-.*\d.*down/i.test(t)&&!/(?:price list|step.by.step|included na|promo price|small down|kapag approved|when you|once approved)/i.test(t))type='Delivery / final billing';
  else if(m.sender==='page'&&t.length<250&&/(?:received|nareceive|na receive|ongoing|on going|proceed na.*editing|start.*editing)/i.test(t)&&!/(?:if |kung |kapag|once|\?)/i.test(t))type='Receipt / production update';
  if(type)ev.push({i,type,text:t});
 }
 if(ev.length||r.paidTag)rows.push({...r,evidence:ev});
}
fs.writeFileSync(p+'review-candidates.json',JSON.stringify(rows));console.log('Pending candidates '+rows.length);
for(const r of rows.slice(Number(process.argv[2]||0),Number(process.argv[3]||25))){console.log('\n'+r.psid+'|'+r.name+'|old='+r.paidTag+'|'+r.messages.length+' messages');for(const e of r.evidence.slice(0,2).concat(r.evidence.slice(-2)).filter((x,i,a)=>a.findIndex(y=>y.i===x.i)===i)){console.log(e.i+' '+r.messages[e.i].sender+' '+e.type+': '+e.text.replace(/\n/g,' | ').slice(0,600));const after=r.messages.slice(e.i+1,e.i+3).filter(m=>m.text);for(const m of after)console.log('  > '+m.sender+': '+m.text.replace(/\n/g,' | ').slice(0,200));}}

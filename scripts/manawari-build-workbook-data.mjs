import fs from 'node:fs';
const p='analysis-output/manawari-2026-09-15/';
const records=JSON.parse(fs.readFileSync(p+'live-records.json'));const decisions=JSON.parse(fs.readFileSync(p+'review-decisions.json'));const details=JSON.parse(fs.readFileSync(p+'client-details.json'));const supplements=JSON.parse(fs.readFileSync(p+'business-supplements.json'));const contacts=JSON.parse(fs.readFileSync(p+'contacts.json'));
const byId=new Map(records.map(r=>[r.psid,r]));const allCandidates=new Set(JSON.parse(fs.readFileSync(p+'live-candidates.json')).map(r=>r.psid));
const audits=fs.readdirSync(p).filter(f=>/^tag-audit-/.test(f)).map(f=>JSON.parse(fs.readFileSync(p+f))).filter(x=>x.status==='verified');
const newTags=new Map(audits.flatMap(a=>a.entries.map(e=>[e.psid,a.completedAt])));
const date=s=>s?new Date(new Date(s).getTime()+8*3600000).toISOString().slice(0,10):null;
const uniq=a=>[...new Set(a.filter(Boolean))];
const staff=new Set(['09101525836','09550197341','09928403782','09150691352','09455911212','09928214519','09912705202','09604022339','09666026458','09929410610','09944869941','09565603754','09663445733','09602863740']);
const phone=t=>uniq([...(t.match(/(?:\+?63[\s-]*|0)9(?:[\s–—-]*\d){9}\b/g)||[]).map(s=>s.replace(/\D/g,'')).map(s=>s.startsWith('63')?'0'+s.slice(2):s),...(t.match(/\+(?!63)(?:\d[ -]?){9,14}\d\b/g)||[]).map(s=>'+'+s.replace(/\D/g,'')),...((/contact|phone|mobile|whatsapp|viber|telegram/i.test(t)||/^\s*9[\d -]+\s*$/.test(t))?(t.match(/(?<!\d)9(?:[ -]*\d){9}(?!\d)/g)||[]).map(s=>'0'+s.replace(/\D/g,'')):[])]).filter(s=>!staff.has(s));
const clean=s=>s.replace(/^[\s:•✨-]+|[”"\s]+$/g,'').trim();
const nameclean=s=>clean(s.split(/\n|\bPage\s*[:/]|\bLocation\s*:|\bLication\s*:/i)[0]);
const useful=s=>s&&!/^(?:po ano|lang po|ano po|personal use|not applicable)/i.test(s)&&!/^(?:n\/?a|none|wala(?: pa)?|to follow|not applicable|no idea|business name|fb|facebook|po|opo)$/i.test(s)&&!/^https?:/i.test(s);
const clients=[],history=[],events=[],evidence=[],billing=[],review=[],coverage=[];
for(const c of details){const r=byId.get(c.psid),dec=decisions[c.psid];if(!dec?.qualifies){review.push([c.name,'Existing paid/service tag — text not corroborated',c.firstMessage,c.lastMessage,c.messageCount,'Existing tag retained; verify receipts or external service records',c.source,c.psid]);continue;}
 const forms=c.forms;let names=uniq(forms.flatMap(f=>Object.entries(f.fields).filter(([k])=>/^business(?:\s*name)?$|company\s*name/i.test(k)).map(([,v])=>nameclean(v))).filter(useful));
 const sup=supplements.filter(s=>s.psid===c.psid);names=uniq([...names,...sup.map(s=>s.business)]);
 const fields=(re)=>uniq(forms.flatMap(f=>Object.entries(f.fields).filter(([k])=>re.test(k)).map(([,v])=>clean(v))));
 let locations=fields(/location|address/i).filter(useful);const goals=uniq([...fields(/goal|purpose|main problem/i).filter(useful),...sup.map(s=>s.fields?.goal)]);const lengths=fields(/length/i);
 const services=uniq([...fields(/products|services|business.*type/i),...sup.map(s=>s.fields?.services)]);
 const sharedLinks=uniq(c.urls.filter(u=>/facebook|instagram|tiktok|\.com|\.ph|\.org/i.test(u.url)&&!/(?:suno|drive.google|youtube|youtu.be|lazada)/i.test(u.url)).map(u=>u.url));
 locations=uniq([...locations,...sup.map(s=>s.fields?.location)]);
 for(const s of sup)if(s.fields?.replaceBusiness&&s.business)names=[s.business];
 let numbers=uniq(forms.flatMap(f=>Object.entries(f.fields).filter(([k])=>/contact|phone/i.test(k)).flatMap(([,v])=>phone(v))));
 numbers=uniq([...numbers,...sup.flatMap(s=>phone(s.sourceText))]);
 numbers=uniq([...numbers,...r.messages.filter(m=>m.sender==='contact'&&m.text.length<700&&!/gcash|payment|bayad|down ?payment|rempillo|sherrydan|fatima|jauci/i.test(m.text)).flatMap(m=>phone(m.text))]);
 // Explicit later number corrections replace the earlier phone list in the summary.
 for(const m of r.messages)if(m.sender==='contact'&&/correct(?:ion)?|(?:number|cp).*(?:ko|dapat)|(?:palitan|change).*number/i.test(m.text)&&phone(m.text).length&&!/gcash|payment|bayad/i.test(m.text))numbers=phone(m.text);
 for(const s of sup)if(s.fields?.phone)numbers=s.fields.phone.split(';').map(x=>x.trim()).filter(Boolean);
 const emails=uniq([...c.contacts.flatMap(x=>x.values),...sup.map(s=>s.fields?.email)]);
 const source=c.source;const logged=new Set();
 function hist(i,type,value){const m=r.messages[i];const key=i+'|'+type+'|'+value;if(logged.has(key)||!m)return;logged.add(key);history.push([c.name,date(m.date),type,value,m.sender,m.id,source,c.psid]);}
 for(const f of forms){for(const [k,v] of Object.entries(f.fields))hist(f.index,k,v);hist(f.index,'Original business brief / details',f.sourceText);}
 for(const s of sup){if(s.business)hist(s.index,'Business name — reviewed',s.business);hist(s.index,'Business brief — original',s.sourceText);for(const [k,v] of Object.entries(s.fields||{}))if(k!=='replaceBusiness')hist(s.index,'Reviewed '+k,v);}
 for(const e of c.contacts)hist(e.index,'Email mentioned by client',e.values.join('; '));
 for(const u of c.urls)if(/facebook|instagram|tiktok|shopee|lazada|\.com|\.ph|\.org/i.test(u.url)&&!/(?:suno|drive.google|youtube|youtu.be)/i.test(u.url))hist(u.index,'Link shared by client — ownership not assumed',u.url);
 // Examine every incoming message across the entire available history, including corrections.
 for(let i=0;i<r.messages.length;i++){const m=r.messages[i],t=m.text;if(m.sender!=='contact'||!t)continue;
  if(phone(t).length&&!/gcash|payment|bayad|downpayment|rempillo|sherrydan|fatima|jauci/i.test(t))hist(i,'Contact details mentioned — check context',t);
  if(t.length>25&&t.length<6000&&/business|location|address|\bshop\b|\bstore\b|\bbranch\b|\bservices\b|open (?:daily|from|every)|contact (?:no|number)|pangalan|company|since \d{4}|palitan.*(?:number|name)|correction|hindi carmens/i.test(t)&&!/(?:gcash|down ?payment|payment|crohn|naoperahan|remicade|pregnancy test|abortion|mantainance)/i.test(t))hist(i,'Business context / correction — client wording',t);
 }
 // Preserve longer client briefs even when they use no standard business labels.
 for(let i=0;i<r.messages.length;i++){const m=r.messages[i],t=m.text;if(m.sender==='contact'&&t.length>=150&&!forms.some(f=>f.index===i)&&!sup.some(s=>s.index===i)&&!/(?:gcash|payment|bayad|down ?payment|crohn|naoperahan|remicade|pregnancy test|abortion)/i.test(t))hist(i,'Additional client brief / instructions',t);}
 const idx=uniq(dec.evidenceIndexes||[]).sort((a,b)=>a-b);let pay=c.bills.some(b=>/^\s*(?:PHP|P|₱)?\s*[1-9]/i.test(b.downPayment));
 for(const i of idx){const m=r.messages[i];if(!m)throw Error('Bad evidence '+c.name);evidence.push([c.name,date(m.date),dec.reason,m.text,m.sender,m.id,source,c.psid]);
  if((m.sender==='page'&&/(?:Down\s*Payment\s*:\s*(?:₱|PHP)?\s*\d|payment (?:received|confirmed)|received payment|since.*(?:dp|down)|na.less.*(?:dp|down)|\d.*-.*\d.*down)/i.test(m.text))||(m.sender==='contact'&&!/^(?:if|kung|kapag|pag)|\b(?:bago|once)\b/i.test(m.text)&&/done payment|fully paid|paid na|nagpay na|nakapag pay na|nag ?down|ngdown|nag ?send.*(?:gcash|dp)|nasend.*balance|na send.*\d|nabayaran|nagbayad na|binayad ko|payment.*(?:sent|done)/i.test(m.text)))pay=true;
  events.push([c.name,date(m.date),'Reviewed payment / service evidence',m.text,m.id,source,c.psid]);
 }
 const starts=[];
 for(let i=0;i<r.messages.length;i++){const m=r.messages[i],t=m.text;
  if(m.sender==='page'&&t.length<550&&/(?:ongoing|on going|generating na|nagstart|nag start|sinimulan|proceed na.{0,25}(?:editing|video production)|start ko na.{0,25}(?:video|production)|working on (?:our|your|the) (?:project|video))/i.test(t)&&!/(?:\bif\b|kung|kapag|once|bukas.*start|tomorrow.*start|will start|\?)/i.test(t))starts.push({index:i,date:date(m.date),text:t});
  if(m.sender==='page'&&/Start Date:\s*[A-Za-z]+ \d{1,2}, \d{4}/i.test(t)){const stated=t.match(/Start Date:\s*([A-Za-z]+ \d{1,2}, \d{4})/i)[1];const dt=new Date(stated+' 00:00:00 +0800');if(!isNaN(dt))starts.push({index:i,date:date(dt),text:t});}
 }
 for(let i=starts.length-1;i>=0;i--)if(!/video|editing|production|project|Start Date:/i.test(starts[i].text)||/ongoing.{0,15}promo|promo.{0,15}ongoing|proceed.{0,20}\bba\b|start.{0,15}\bba\b/i.test(starts[i].text))starts.splice(i,1);
 for(let i=starts.length-1;i>=0;i--)if(/\bpara\b|\bpag\b|\bafter\b|\bbefore\b|\bbukas\b|\btomorrow\b|pa.?approve|pa.?check|pasend|waiting for|we.ll start|we.ll be sending|may ongoing project/i.test(starts[i].text))starts.splice(i,1);
 starts.sort((a,b)=>a.date.localeCompare(b.date));
 const ends=[];
 for(let i=0;i<r.messages.length;i++){const m=r.messages[i],t=m.text;if(m.sender==='page'&&t.length<500&&/(?:here|eto|ito|hero|this is|uploaded|sent).*(?:original (?:copy|video)|final(?:ized)? (?:video|output)|clear copy|without watermark|walang watermark)|(?:original (?:copy|video)|final(?:ized)? video).*?(?:here|eto|ito|uploaded)/i.test(t)&&!/(?:once|kapag|kung|if |after|bago|muna|sample|send ko|isesend|i.ready|ready ko|tomorrow|bukas|will |isend)/i.test(t))ends.push({index:i,date:date(m.date),text:t});}
 for(const e of starts)events.push([c.name,e.date,'Production started / in progress',e.text,r.messages[e.index].id,source,c.psid]);
 for(const e of ends)events.push([c.name,e.date,/clear copy|without watermark|walang watermark|original/i.test(e.text)?'Documented final delivery':'Video output for review; full payment not established',e.text,r.messages[e.index].id,source,c.psid]);
 for(const b of c.bills)billing.push([c.name,b.date,b.downPayment,b.package,b.revisionFee,b.balance,'Historical quote / billing message; not current receivable or verified revenue',b.sourceText,r.messages[b.index].id,source,c.psid]);
 const first=idx.length?date(r.messages[idx[0]].date):null;
 const actualEnds=ends.filter(e=>!r.messages.slice(e.index+1,e.index+4).some(m=>m.sender==='page'&&/with watermark.*(?:pala|sorry)|may watermark.*pala/i.test(m.text))).filter(e=>!/final(?:ized)? (?:video|output)/i.test(e.text)||/clear copy|without watermark|walang watermark|original/i.test(e.text));
 clients.push([c.name,names.join('; ')||'Not stated in reviewed text',numbers.join('; '),emails.join('; '),locations.join('; '),goals.join('; '),lengths.join('; '),starts[0]?.date||null,actualEnds.at(-1)?.date||null,first,c.firstMessage,c.lastMessage,pay?'Payment/deposit evidence; full payment not assumed':'Service availed; full payment not confirmed',newTags.has(c.psid)?'New tag verified':r.paidTag?'Existing tag corroborated':r.tags.length?'Other existing tag preserved':'Pending tag application',date(newTags.get(c.psid)),c.messageCount,source,c.psid,services.join('; '),sharedLinks.join('\n'),uniq([...fields(/hours/i),...sup.map(s=>s.fields?.hours)]).join('; '),uniq(sup.map(s=>s.fields?.contactPerson)).join('; '),[dec.reason,...sup.map(s=>s.fields?.sourceNote)].filter(Boolean).filter((v,i,a)=>a.indexOf(v)===i).join(' | ')]);
}
for(const r of records){const d=decisions[r.psid],isReview=!d?.qualifies&&(r.paidTag||allCandidates.has(r.psid));if(isReview&&!r.paidTag)review.push([r.name,'No qualifying evidence established',date(r.messages[0]?.date),date(r.messages.at(-1)?.date),r.messages.length,d?.reason||'Inquiry, sample, payment question or ambiguous text; no new tag applied',`https://business.facebook.com/latest/inbox/all?asset_id=619355471260631&selected_item_id=${r.psid}`,r.psid]);
 coverage.push([r.name||'Unavailable participant (empty live record)',r.psid,r.messages.length,date(r.messages[0]?.date),date(r.messages.at(-1)?.date),d?.qualifies?'Supported paid / availed service':r.paidTag?'Existing tag needs review':isReview?'Unconfirmed candidate':'No qualifying signal found',r.paidTag?'Existing paid/service tag':newTags.has(r.psid)?'New paid/service tag':r.tags.length?'Other existing tag':'No new tag',r.conversationId]);}
const seen=new Set(records.map(r=>r.psid));for(const c of contacts)if(!seen.has(c.psid))coverage.push([c.name,c.psid,0,null,null,'No available live conversation returned','Database contact only','']);
clients.sort((a,b)=>a[0].localeCompare(b[0]));history.sort((a,b)=>a[0].localeCompare(b[0])||a[1].localeCompare(b[1]));events.sort((a,b)=>a[0].localeCompare(b[0])||a[1].localeCompare(b[1]));review.sort((a,b)=>a[1].localeCompare(b[1])||a[0].localeCompare(b[0]));
for(const c of clients)if(c[7]&&c[8]&&c[7]>c[8])c[22]+=' | Date note: the delivery predates a later production update. These dates refer to separate work stages or orders, not one continuous project.';
const meta={page:'Manawari Studios',reviewDate:'2026-09-15',timezone:'Asia/Manila',liveConversations:records.length,messages:records.reduce((a,r)=>a+r.messages.length,0),databaseContacts:contacts.length,newTags:newTags.size,confirmedClients:clients.length,legacyReview:details.filter(c=>!decisions[c.psid]?.qualifies).length,missingLive:contacts.filter(c=>!seen.has(c.psid)).length};
meta.baselinePaidTags=JSON.parse(fs.readFileSync(p+'tags-before.json')).filter(t=>t.tag_id==='f325fe8b-43a6-4e44-8198-b6463694e948').length;
fs.writeFileSync(p+'workbook-data.json',JSON.stringify({meta,clients,history,events,evidence,billing,review,coverage}));console.log(JSON.stringify({...meta,history:history.length,events:events.length,evidence:evidence.length,billing:billing.length,review:review.length,coverage:coverage.length}));

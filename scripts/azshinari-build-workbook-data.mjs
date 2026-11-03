import fs from 'node:fs';
const p='analysis-output/azshinari-2026-09-15/';
const records=JSON.parse(fs.readFileSync(p+'live-records.json'));const decisions=JSON.parse(fs.readFileSync(p+'review-decisions.json'));const details=JSON.parse(fs.readFileSync(p+'client-details.json'));const supplements=JSON.parse(fs.readFileSync(p+'business-supplements.json'));const contacts=JSON.parse(fs.readFileSync(p+'contacts.json'));
const byId=new Map(records.map(r=>[r.psid,r]));const allCandidates=new Set(JSON.parse(fs.readFileSync(p+'live-candidates.json')).map(r=>r.psid));
const audits=fs.readdirSync(p).filter(f=>/^tag-audit-/.test(f)).map(f=>JSON.parse(fs.readFileSync(p+f))).filter(x=>x.status==='verified');
const newTags=new Map(audits.flatMap(a=>a.entries.map(e=>[e.psid,a.completedAt])));
const date=s=>s?new Date(new Date(s).getTime()+8*3600000).toISOString().slice(0,10):null;
const uniq=a=>[...new Set(a.filter(Boolean))];
const staff=new Set(['09101525836','09550197341','09928403782']);
const phone=t=>uniq((t.match(/(?:\+?63|0)9(?:[\s–—-]*\d){9}\b/g)||[]).map(s=>s.replace(/\D/g,'')).map(s=>s.startsWith('63')?'0'+s.slice(2):s).filter(s=>!staff.has(s)));
const clean=s=>s.replace(/^[\s:•✨-]+|[”"\s]+$/g,'').trim();
const nameclean=s=>clean(s.split(/\n|\bPage\s*[:/]|\bLocation\s*:|\bLication\s*:/i)[0]);
const useful=s=>s&&!/^(?:n\/?a|none|wala(?: pa)?|to follow|not applicable|no idea|business name|fb|facebook)$/i.test(s)&&!/^https?:/i.test(s);
const clients=[],history=[],events=[],evidence=[],billing=[],review=[],coverage=[];
for(const c of details){const r=byId.get(c.psid),dec=decisions[c.psid];if(!dec?.qualifies){review.push([c.name,'Existing paid/service tag — text not corroborated',c.firstMessage,c.lastMessage,c.messageCount,'Existing tag retained; verify receipts or external service records',c.source,c.psid]);continue;}
 const forms=c.forms;let names=uniq(forms.flatMap(f=>Object.entries(f.fields).filter(([k])=>/^business(?:\s*name)?$|company\s*name/i.test(k)).map(([,v])=>nameclean(v))).filter(useful));
 const sup=supplements.filter(s=>s.psid===c.psid);names=uniq([...names,...sup.map(s=>s.business)]);
 const fields=(re)=>uniq(forms.flatMap(f=>Object.entries(f.fields).filter(([k])=>re.test(k)).map(([,v])=>clean(v))));
 const locations=fields(/location|address/i).filter(useful);const goals=fields(/goal|purpose/i).filter(useful);const lengths=fields(/length/i);
 let numbers=uniq(forms.flatMap(f=>Object.entries(f.fields).filter(([k])=>/contact|phone/i.test(k)).flatMap(([,v])=>phone(v))));
 numbers=uniq([...numbers,...sup.flatMap(s=>phone(s.sourceText))]);
 numbers=uniq([...numbers,...r.messages.filter(m=>m.sender==='contact'&&m.text.length<700&&!/gcash|payment|bayad|down ?payment|rempillo|sherrydan|fatima|jauci/i.test(m.text)).flatMap(m=>phone(m.text))]);
 // Explicit later number corrections replace the earlier phone list in the summary.
 for(const m of r.messages)if(m.sender==='contact'&&/correct(?:ion)?|(?:number|cp).*(?:ko|dapat)|(?:palitan|change).*number/i.test(m.text)&&phone(m.text).length&&!/gcash|payment|bayad/i.test(m.text))numbers=phone(m.text);
 const emails=uniq(c.contacts.flatMap(x=>x.values));
 const source=c.source;const logged=new Set();
 function hist(i,type,value){const m=r.messages[i];const key=i+'|'+type+'|'+value;if(logged.has(key)||!m)return;logged.add(key);history.push([c.name,date(m.date),type,value,m.sender,m.id,source,c.psid]);}
 for(const f of forms)for(const [k,v] of Object.entries(f.fields))hist(f.index,k,v);
 for(const s of sup){hist(s.index,'Business name — reviewed',s.business);hist(s.index,'Business brief — original',s.sourceText);}
 for(const e of c.contacts)hist(e.index,'Email mentioned by client',e.values.join('; '));
 for(const u of c.urls)if(/facebook|instagram|tiktok|shopee|lazada|\.com|\.ph|\.org/i.test(u.url)&&!/(?:suno|drive.google|youtube|youtu.be)/i.test(u.url))hist(u.index,'Link shared by client — ownership not assumed',u.url);
 // Examine every incoming message across the entire available history, including corrections.
 for(let i=0;i<r.messages.length;i++){const m=r.messages[i],t=m.text;if(m.sender!=='contact'||!t)continue;
  if(phone(t).length&&!/gcash|payment|bayad|downpayment|rempillo|sherrydan|fatima|jauci/i.test(t))hist(i,'Contact details mentioned — check context',t);
  if(t.length>25&&t.length<6000&&/business|location|address|\bshop\b|\bstore\b|\bbranch\b|\bservices\b|open (?:daily|from|every)|contact (?:no|number)|pangalan|company|since \d{4}|palitan.*(?:number|name)|correction|hindi carmens/i.test(t)&&!/(?:gcash|down ?payment|payment|crohn|naoperahan|remicade|pregnancy test|abortion|mantainance)/i.test(t))hist(i,'Business context / correction — client wording',t);
 }
 const idx=uniq(dec.evidenceIndexes||[]).sort((a,b)=>a-b);let pay=false;
 for(const i of idx){const m=r.messages[i];if(!m)throw Error('Bad evidence '+c.name);evidence.push([c.name,date(m.date),dec.reason,m.text,m.sender,m.id,source,c.psid]);
  if((m.sender==='page'&&/(?:Down\s*Payment\s*:\s*(?:₱|PHP)?\s*\d|confirmed that.*made a payment|since.*(?:dp|down)|na.less.*(?:dp|down)|\d.*-.*\d.*down)/i.test(m.text))||(m.sender==='contact'&&!/^(?:if|kung|kapag|pag)|\b(?:bago|once)\b/i.test(m.text)&&/done payment|fully paid|paid na|nagpay na|nakapag pay na|nag ?down|ngdown|nag ?send.*(?:gcash|dp)|nasend.*balance|na send.*\d|nabayaran|nagbayad na|binayad ko|payment.*(?:sent|done)/i.test(m.text)))pay=true;
  events.push([c.name,date(m.date),'Reviewed payment / service evidence',m.text,m.id,source,c.psid]);
 }
 const starts=c.starts.filter(e=>!/(?:patapos|malapit|tomorrow|bukas|before|send|isesend)/i.test(e.text));
 const ends=[];
 for(let i=0;i<r.messages.length;i++){const m=r.messages[i],t=m.text;if(m.sender==='page'&&t.length<500&&/(?:here|eto|ito|hero|this is|uploaded|sent).*(?:original (?:copy|video)|final(?:ized)? (?:video|output)|clear copy|without watermark|walang watermark)|(?:original (?:copy|video)|final(?:ized)? video).*?(?:here|eto|ito|uploaded)/i.test(t)&&!/(?:once|kapag|kung|if |after|bago|muna|sample|send ko|isesend|i.ready|ready ko|tomorrow|bukas|will |isend)/i.test(t))ends.push({index:i,date:date(m.date),text:t});}
 for(const e of starts)events.push([c.name,e.date,'Production started / in progress',e.text,r.messages[e.index].id,source,c.psid]);
 for(const e of ends)events.push([c.name,e.date,'Documented final delivery',e.text,r.messages[e.index].id,source,c.psid]);
 for(const b of c.bills)billing.push([c.name,b.date,b.downPayment,b.package,b.revisionFee,b.balance,'Historical quote / billing message; not current receivable or verified revenue',b.sourceText,r.messages[b.index].id,source,c.psid]);
 const first=idx.length?date(r.messages[idx[0]].date):null;
 clients.push([c.name,names.join('; ')||'Not stated in reviewed text',numbers.join('; '),emails.join('; '),locations.join('; '),goals.join('; '),lengths.join('; '),starts[0]?.date||null,ends.at(-1)?.date||null,first,c.firstMessage,c.lastMessage,pay?'Payment/deposit evidence':'Service availed; full payment not confirmed',newTags.has(c.psid)?'New tag verified':'Existing tag corroborated',date(newTags.get(c.psid)),c.messageCount,source,c.psid]);
}
for(const r of records){const d=decisions[r.psid],isReview=!d?.qualifies&&(r.paidTag||allCandidates.has(r.psid));if(isReview&&!r.paidTag)review.push([r.name,'No qualifying evidence established',date(r.messages[0]?.date),date(r.messages.at(-1)?.date),r.messages.length,d?.reason||'Inquiry, sample, payment question or ambiguous text; no new tag applied',`https://business.facebook.com/latest/inbox/all?asset_id=656646850875530&selected_item_id=${r.psid}`,r.psid]);
 coverage.push([r.name,r.psid,r.messages.length,date(r.messages[0]?.date),date(r.messages.at(-1)?.date),d?.qualifies?'Supported paid / availed service':r.paidTag?'Existing tag needs review':isReview?'Unconfirmed candidate':'No qualifying signal found',r.paidTag?'Existing paid/service tag':newTags.has(r.psid)?'New paid/service tag':r.tags.length?'Other existing tag':'No new tag',r.conversationId]);}
const seen=new Set(records.map(r=>r.psid));for(const c of contacts)if(!seen.has(c.psid))coverage.push([c.name,c.psid,0,null,null,'No available live conversation returned','Database contact only','']);
clients.sort((a,b)=>a[0].localeCompare(b[0]));history.sort((a,b)=>a[0].localeCompare(b[0])||a[1].localeCompare(b[1]));events.sort((a,b)=>a[0].localeCompare(b[0])||a[1].localeCompare(b[1]));review.sort((a,b)=>a[1].localeCompare(b[1])||a[0].localeCompare(b[0]));
const meta={page:'Azshinari',reviewDate:'2026-09-15',timezone:'Asia/Manila',liveConversations:records.length,messages:records.reduce((a,r)=>a+r.messages.length,0),databaseContacts:contacts.length,newTags:newTags.size,confirmedClients:clients.length,legacyReview:details.filter(c=>!decisions[c.psid]?.qualifies).length,missingLive:contacts.filter(c=>!seen.has(c.psid)).length};
fs.writeFileSync(p+'workbook-data.json',JSON.stringify({meta,clients,history,events,evidence,billing,review,coverage}));console.log(JSON.stringify({...meta,history:history.length,events:events.length,evidence:evidence.length,billing:billing.length,review:review.length,coverage:coverage.length}));

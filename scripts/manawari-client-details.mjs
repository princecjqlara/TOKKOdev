import fs from 'node:fs';
const dir='analysis-output/manawari-2026-09-15/';
const records=JSON.parse(fs.readFileSync(dir+'live-records.json'));
const decisions=JSON.parse(fs.readFileSync(dir+'review-decisions.json'));
const qualified=records.filter(r=>r.paidTag||decisions[r.psid]?.qualifies);
const label=/^\s*(?:\d+[.)]\s*)?(Pangalan\s*ng\s*business|Products?\s*[|/]?\s*(?:Services)?\s*(?:na\s*i[- ]?(?:hi)?highlight|to\s*highlight)?|Specialty\s*\/\s*Products|Business\s*(?:Page\s*(?:\/\s*Social\s*Media\s*)?Link|Name|Location|Type)?|Company\s*Name|Registered\s*Name|Page\s*(?:\/\s*Social\s*Media)?\s*Link|Location|Address|Goal\s*(?:ng|of the|of)?\s*Video|Purpose\s*(?:of\s*)?(?:the\s*)?Video|Preferred\s*(?:Video\s*)?Length(?:\s*\([^)]*\))?|Preferred\s*Style(?:\s*\/\s*Inspiration)?(?:\s*\([^)]*\))?|Contacts?\s*(?:Number|No\.?|#)?|(?:Cell)?Phone\s*(?:Number|No\.?)?|Email(?:\s*Address)?|Portrait\s*or\s*Landscape\??|Main\s*Problem[^:]*|Business\s*Hours|Opening\s*Hours)\s*[:=.-]\s*(.*?)\s*$/i;
const normalize=s=>s.normalize('NFKC').replace(/\u200b/g,'').trim();
function date(s){return s?new Date(new Date(s).getTime()+8*3600000).toISOString().slice(0,10):'';}
const clients=[];
for(const r of qualified){
 const forms=[];const contacts=[];const urls=[];const delivery=[];const starts=[];const bills=[];
 for(let i=0;i<r.messages.length;i++){
  const m=r.messages[i], t=normalize(m.text);
  if(m.sender==='contact'){
   const fields={};let pending='';for(const raw of t.split(/\r?\n/)){
    const line=raw.replace(/[*_]/g,'').replace(/^\s*[-•]\s*/, '').trim();if(!line)continue;
    const match=line.match(label);
    const flexible=line.match(/^(?:\d+[.)]\s*)?(Business\s*(?:Name|nam|Location|Page|Type)|Company\s*Name|Page\s*\/\s*Social\s*Media\s*Link|Location|Address|Contact(?:s|\s*Number|\s*#)?|Email|Goal\s*ng\s*Video|Preferred\s*Video\s*Length)\s*(?::|=|\bis\b)?\s*(.*)$/i);
    const m=match||flexible;if(m){pending=m[1].replace(/^Business nam$|^Pangalan\s*ng\s*business$/i,'Business Name').replace(/^Registered Name$/i,'Company Name').replace(/^Products?.*|^Specialty.*/i,'Products / Services');if(m[2])fields[pending]=m[2];}
    else if(pending&&!/^\d+[.)]|^Preferred|^Main Problem|^Portrait|^Landscape|^Request|^Paki |^Logo$|^Picture ng|^Videos na|^FOR THE COMMERCIAL|^Other requests/i.test(line)){fields[pending]=(fields[pending]?fields[pending]+'\n':'')+line;}
    else pending='';
   }
   // Older briefs replace template labels with numbered answers.
   if(Object.keys(fields).length<3&&/^\s*1[.)]\s*/m.test(t)&&/^\s*3[.)]\s*/m.test(t)&&/^\s*7[.)]\s*/m.test(t)){
    const numbered=[...t.matchAll(/^\s*(\d+)[.)]\s*([^\n]*(?:\n(?!\s*\d+[.)])[^\n]*)*)/gm)];
    const keys={1:'Business Name',2:'Business Page Link',3:'Business Location',4:'Goal of Video',5:'Preferred Video Length',6:'Preferred Style',7:'Contacts Number',8:'Portrait or Landscape'};
    for(const n of numbered){const k=keys[n[1]],v=n[2].trim();if(k&&v&&!/^(?:Business Page|Social Media|Business Name|Business Location|Contacts|Preferred|Main Problem)/i.test(v))fields[k]=v;}
   }
   if(Object.keys(fields).length)forms.push({index:i,date:date(m.date),fields,sourceText:m.text,messageId:m.id});
   const emails=t.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)||[];
   if(emails.length)contacts.push({type:'Email mentioned by client',values:[...new Set(emails)],date:date(m.date),index:i,sourceText:m.text});
   for(const u of t.match(/https?:\/\/[^\s<>]+/g)||[])urls.push({url:u,index:i,date:date(m.date),context:m.text});
  }
  if(m.sender==='page'){
   if(/(?:ongoing|on going|sinimulan|nagstart|nag start|proceed na po ako sa (?:video|pag gawa|paggawa)|start ko na po.*(?:video|gawin))/i.test(t)&&t.length<500&&!/(?:if |kung |kapag|once|\?)/i.test(t))starts.push({index:i,date:date(m.date),text:m.text});
   if(t.length<400&&/(?:here|eto|ito).*?(?:video|copy).*?(?:without watermark|walang watermark)/i.test(t)&&!/(?:once|kapag|if |kung|bago|muna|after|sample)/i.test(t))delivery.push({index:i,date:date(m.date),text:m.text});
   if(/(?:Remaining\s*)?Balance(?:\s*to\s*pay)?\s*:/i.test(t)&&/(?:Down\s*Payment(?:\s*fee)?|DP)\s*:/i.test(t)&&!/(?:you can try|starter pack|before:|free inclusions|step.by.step)/i.test(t)){
    const take=re=>t.match(re)?.[1]?.trim()||'';
    const dp=take(/(?:Down\s*Payment(?:\s*fee)?|DP)\s*:\s*([^\n]*)/i),pkg=take(/Package(?:\s*availed)?\s*:\s*([^\n]*)/i),rev=take(/Revis(?:ion|on)(?:\s*Fees?)?\s*:\s*([^\n]*)/i),bal=take(/(?:Remaining\s*)?Balance(?:\s*to\s*pay)?\s*:\s*([^\n]*)/i);
    if(/[0-9]/.test(dp+pkg+bal))bills.push({index:i,date:date(m.date),downPayment:dp,package:pkg,revisionFee:rev,balance:bal,sourceText:m.text});
   }
  }
 }
 clients.push({psid:r.psid,name:r.name,contactId:r.contactId,conversationId:r.conversationId,existingPaidTag:r.paidTag,firstMessage:date(r.messages[0]?.date),lastMessage:date(r.messages.at(-1)?.date),messageCount:r.messages.length,forms,contacts,urls,starts,delivery,bills,qualification:decisions[r.psid]||{reason:'Existing Paid / Availed Service tag; retained'},source:`https://business.facebook.com/latest/inbox/all?asset_id=619355471260631&selected_item_id=${r.psid}`});
}
fs.writeFileSync(dir+'client-details.json',JSON.stringify(clients,null,2));
console.log(JSON.stringify({clients:clients.length,withForms:clients.filter(r=>r.forms.length).length}));
if(process.argv[2]==='review')for(const r of clients.slice(Number(process.argv[3]||0),Number(process.argv[4]||20))){console.log(`\n### ${r.name}|${r.psid}`);for(const f of r.forms)console.log(`${f.index} ${f.date} ${JSON.stringify(f.fields)}`);}

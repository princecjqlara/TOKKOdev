import fs from 'node:fs';
import path from 'node:path';
const dir=path.resolve('analysis-output/onset-2026-09-17');
const contacts=JSON.parse(fs.readFileSync(path.join(dir,'contacts.json')));
const tags=JSON.parse(fs.readFileSync(path.join(dir,'tags.json')));
const byPsid=new Map(contacts.map(c=>[c.psid,c]));
const pageId='699579919911250';
const paidIds=new Set(tags.filter(t=>t.tags?.name==='PAID').map(t=>t.contact_id));
const notes={
 '38576504555267083':'Do not mark fully paid from the PAID tag: package PHP 699, down payment PHP 150, remaining balance PHP 549. On September 4 the customer requested more time because funds were on hold; staff continued asking for settlement.',
 '27989413577334995':'Duplicate-order risk: on August 27 staff wrote "I already marked as paid napo". No formal order notification was returned. Multiple video purchases and revision charges appear in chat, so do not infer the latest paid total from the PHP 1,299 billing message alone.',
 '27536341112734875':'September 4 staff specified PHP 1,549 remaining after PHP 150 down payment (PHP 1,699 total by arithmetic). September 7 staff said the payment was short PHP 49, followed by an image-only message. Final settlement requires receipt verification.',
 '27952111251077816':'PHP 1,299 billing total with PHP 150 down payment and PHP 1,149 balance. Customer said "Paid na ko" on August 28 and staff proceeded to send via Viber. A PHP 10 transfer-fee adjustment was discussed; verify the actual receipt before recording collected amount.',
 '28506075239030173':'PHP 549 remaining balance was confirmed by staff after the PHP 150 down-payment process (PHP 699 total by arithmetic). Image-only messages were not inspected; no direct full-payment confirmation established.',
 '37813604308254912':'Staff still requested final payment on September 3-4. PAID tag alone does not establish full settlement; latest order total is unverified.',
 '29057725380495235':'Customer discussed insufficient budget and staff were still waiting for script approval. PAID tag alone does not establish full settlement or a final paid order amount.',
 '28535191902741873':'Business details and script preparation are recorded, but no explicit final-settlement amount was established in reviewed text. Do not mark fully paid solely from the tag.',
 '38375275468730277':'Order request is PHP 900; the September 14 billing breakdown says package PHP 899. Confirm the PHP 1 difference.',
 '29138402612429249':'Customer confirmed the order, then said "I\'ll send later". Confirmation does not establish payment.',
 '28569183672711732':'Chat records PHP 150 down payment against PHP 699 package, with PHP 549 remaining. Customer said they could not pay the balance yet. No formal order record found.',
 '28000244486314380':'Customer reported paying the down payment; video was approved and final payment requested. Agreed package PHP 1,099 in chat. No formal order record found; full payment is unconfirmed.',
 '23934981812869955':'Historical August 2025 customer: final balance discussed and watermark-free output delivered. No formal order record found. Do not treat a remaining balance as the order total.',
 '24808681388735565':'Historical August 2025 customer: customer said they would send the balance, followed by delivery without watermarks. No formal order record found.',
 '30858060773841984':'Historical August 2025 customer: "Sent payment po sir" followed by staff acknowledgement and delivery. No formal order record found.',
 '24799198799684701':'Historical August/September 2025 production work and repeated requests for PHP 2,999 remaining balance. No settlement confirmation in reviewed excerpts; do not classify as fully paid.',
 '28181096178173693':'Current Facebook participant name is Maria Ditching; stored contact/order name is Bhabez Bhabez. Matched by PSID, not name.',
 '29231101679815671':'Current Facebook participant name is Lj Pregillana; stored contact name is Lj Pldt Encoder. Matched by PSID.',
};
const extra=new Set(['28569183672711732','28000244486314380','23934981812869955','24808681388735565','30858060773841984','24799198799684701']);
const rows=[];
const evidence=m=>({messageId:m.id,date:m.created_time,text:m.message||''});
for(const file of fs.readdirSync(path.join(dir,'messages'))){
 const c=JSON.parse(fs.readFileSync(path.join(dir,'messages',file)));
 const p=c.participants.data.find(p=>p.id!==pageId);if(!p)continue;
 const contact=byPsid.get(p.id),ms=c.messages.toSorted((a,b)=>a.created_time.localeCompare(b.created_time));
 const stages=ms.filter(m=>m.from?.id===pageId&&/^Lead stage set to /i.test(m.message||'')).map(m=>({...evidence(m),stage:m.message.replace(/^Lead stage set to /i,'').trim()}));
 const orderMap=new Map();
 for(const m of ms){
  const t=m.message||'',id=t.match(/fb-pma:\/\/payments\/orderdetails\/\?[^\s)]*invoice_id=(\d+)/)?.[1];if(!id)continue;
  const o=orderMap.get(id)||{id,firstRecordAt:m.created_time,amount:null,currency:'PHP',events:[]};
  const amount=t.match(/^You (?:created an order for|requested) PHP([\d,]+(?:\.\d{1,2})?)(?=\. |\s)/i)?.[1];
  if(amount&&m.from?.id===pageId){o.amount=Number(amount.replaceAll(',',''));o.creationRecordAt=m.created_time;o.creationType=/^You requested/i.test(t)?'Order requested':'Order created';}
  o.events.push(evidence(m));o.latestEventAt=m.created_time;
  o.latestRecordedStatus=/confirmed an order/i.test(t)?'Customer confirmed':/^You requested/i.test(t)?'Requested':/^You created an order/i.test(t)?'Created':'Other order event';
  orderMap.set(id,o);
 }
 const orders=[...orderMap.values()].sort((a,b)=>(a.creationRecordAt||a.firstRecordAt).localeCompare(b.creationRecordAt||b.firstRecordAt));
 const billing=ms.filter(m=>m.from?.id===pageId&&/Remaining\s*Balance\s*:/i.test(m.message||'')&&/Package\s*:/i.test(m.message||'')).map(evidence);
 const row={name:p.name||contact?.name||p.id,storedName:contact?.name||null,psid:p.id,conversationId:c.id,paidTag:paidIds.has(contact?.id),messageCount:ms.length,fetchedAt:c.fetchedAt,lastMessageAt:ms.at(-1)?.created_time,stages,latestRecordedStage:stages.at(-1)||null,orders,latestOrder:orders.at(-1)||null,latestBillingMessage:billing.at(-1)||null,note:notes[p.id]||'',additionalReview:extra.has(p.id),inboxUrl:`https://business.facebook.com/latest/inbox/all?asset_id=${pageId}&selected_item_id=${p.id}`};
 rows.push(row);
}
rows.sort((a,b)=>a.name.localeCompare(b.name));
const paid=rows.filter(r=>r.paidTag),otherOrders=rows.filter(r=>!r.paidTag&&r.orders.length),additional=rows.filter(r=>r.additionalReview);
const stageCounts={};for(const r of rows)for(const e of r.stages)stageCounts[e.stage]=(stageCounts[e.stage]||0)+1;
const summary={page:'Onset Media Agency',pageId,generatedAt:new Date().toISOString(),conversations:rows.length,messages:rows.reduce((n,r)=>n+r.messageCount,0),storedContacts:contacts.length,fetchErrors:JSON.parse(fs.readFileSync(path.join(dir,'errors.json'))).length,paidContacts:paid.length,paidWithOrders:paid.filter(r=>r.orders.length).length,paidWithoutOrderRecord:paid.filter(r=>!r.orders.length).length,paidWithLatestIntake:paid.filter(r=>r.latestRecordedStage?.stage==='Intake').length,totalOrderContacts:rows.filter(r=>r.orders.length).length,totalDistinctOrders:rows.reduce((n,r)=>n+r.orders.length,0),additionalOrderContacts:otherOrders.length,stageEventCounts:stageCounts,additionalReviewContacts:additional.length};
summary.returnedConversations=JSON.parse(fs.readFileSync(path.join(dir,'conversations.json'))).length;
summary.emptyPageOnlyConversations=summary.returnedConversations-rows.length;
summary.storedContactsWithoutConversation=contacts.filter(c=>!rows.some(r=>r.psid===c.psid)).map(c=>({name:c.name,psid:c.psid}));
fs.writeFileSync(path.join(dir,'audit.json'),JSON.stringify({summary,rows},null,2));
const esc=s=>String(s??'').replaceAll('|','\\|').replace(/\r?\n/g,' ');
const local=s=>s?new Date(new Date(s).getTime()+8*3600000).toISOString().slice(0,16).replace('T',' '):'—';
const amount=n=>n===null||n===undefined?'Unknown':`PHP ${n.toLocaleString('en-US')}`;
function table(list){return ['| Contact | PAID tag | Latest stage event | Latest order amount | Order date (Philippines) | Latest order event | Note |','|---|---|---|---:|---|---|---|',...list.map(r=>`| [${esc(r.name)}](${r.inboxUrl}) | ${r.paidTag?'Yes':'No'} | ${r.latestRecordedStage?esc(r.latestRecordedStage.stage)+' · '+local(r.latestRecordedStage.date):'No stage event found'} | ${r.latestOrder?amount(r.latestOrder.amount):'No order record found'} | ${local(r.latestOrder?.creationRecordAt||r.latestOrder?.firstRecordAt)} | ${r.latestOrder?.latestRecordedStatus||'—'} | ${esc(r.note)} |`)].join('\n');}
const report=[
 '# Onset Media Agency — lead and order review',
 `Reviewed on ${local(summary.generatedAt)} Philippine time.`,
 `Scanned ${summary.conversations} Facebook conversation histories containing ${summary.messages.toLocaleString('en-US')} messages, following all returned pagination links; ${summary.fetchErrors} fetch errors. Cross-referenced ${summary.storedContacts} Tokko contacts and their existing tags.`,
 `Facebook returned ${summary.returnedConversations} threads in total; ${summary.emptyPageOnlyConversations} was an empty Page-only thread. Stored contacts without a returned conversation: ${summary.storedContactsWithoutConversation.map(c=>c.name).join(', ')||'none'}. All 20 PAID-tagged contacts had accessible histories.`,
 '## What the evidence can establish',
 'Orders below come from explicit Facebook order notifications containing an invoice ID, not sales pitches or package quotations. Amount is the recorded order value, not the amount collected. Dates are Philippine time. The PAID tag comes from Tokko and is not independent verification of payment in Meta.',
 'Lead stages are the latest stage-change messages returned in conversation history, not a direct read of the current Leads Center field. No stage event means unknown. No order record means none was found in accessible history; it does not prove no order exists elsewhere. Image-only receipts were not inspected. Keyword screening cannot establish an exhaustive list of all qualified prospects.',
 'A direct read of one observed invoice ID was rejected by Facebook with error #3: "Application does not have the capability to make this API call." Current invoice/payment status therefore remains unverified. No Facebook records, orders, lead stages, or tags were changed; no messages were sent.',
 '## Findings',
 `- ${summary.paidContacts} contacts have an existing PAID tag: ${summary.paidWithOrders} have order records and ${summary.paidWithoutOrderRecord} have no order record in accessible history.`,
 `- ${summary.paidWithLatestIntake} PAID-tagged contacts have Intake as their latest recorded stage event, with no subsequent Qualified/Converted event found.`,
 `- ${summary.totalDistinctOrders} distinct order IDs were found for ${summary.totalOrderContacts} contacts, including ${summary.additionalOrderContacts} contacts without a PAID tag.`,
 `- Stage-event counts across all returned histories: ${Object.entries(stageCounts).map(([s,n])=>`${s}: ${n}`).join('; ')}.`,
 '## Existing PAID contacts',table(paid),
 '## Other contacts with explicit order records',table(otherOrders),
 'These order records alone do not establish that the contact paid.',
 '## Additional contacts needing lead/order review',table(additional),
 'These are conversation-based candidates, not confirmed current Qualified labels. Historical 2025 customers are shown separately through their notes to avoid treating them as new 2026 sales.',
 '## Billing evidence where PAID contacts lack order records',
 ...paid.filter(r=>!r.orders.length&&r.latestBillingMessage).map(r=>`### ${r.name}\n\nBilling message at ${local(r.latestBillingMessage.date)}; this is not a formal order record:\n\n> ${r.latestBillingMessage.text.replace(/\r?\n/g,'\n> ')}`),
 '## Traceability',
 'audit.json includes every scanned conversation, PSID, order IDs, source message IDs and timestamps, stage history, billing evidence, and inbox links. Raw returned messages are in messages/.',
];
fs.writeFileSync(path.join(dir,'Onset-lead-order-review.md'),report.join('\n\n')+'\n');
console.log(JSON.stringify(summary,null,2));
console.log(JSON.stringify({paidMissingOrder:paid.filter(r=>!r.orders.length).map(r=>r.name),paidLatestIntake:paid.filter(r=>r.latestRecordedStage?.stage==='Intake').map(r=>r.name),otherOrders:otherOrders.map(r=>({name:r.name,amount:r.latestOrder.amount})),orders:rows.filter(r=>r.orders.length).map(r=>({name:r.name,amount:r.latestOrder.amount,date:local(r.latestOrder.creationRecordAt),count:r.orders.length}))},null,2));

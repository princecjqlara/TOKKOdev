import fs from 'node:fs';
import path from 'node:path';
import {db,out,pageId,paidTagId} from './manawari-client-audit.mjs';
const decisions=JSON.parse(fs.readFileSync(path.join(out,'review-decisions.json')));
const records=JSON.parse(fs.readFileSync(path.join(out,'live-records.json')));
const {data:tag,error:te}=await db.from('tags').select('id,name,owner_type,owner_id,page_id').eq('id',paidTagId).single();if(te||tag.page_id!==pageId||tag.owner_id!==pageId||tag.name!=='Paid / Availed Service')throw new Error('Tag scope mismatch');
const approved=records.filter(r=>decisions[r.psid]?.qualifies&&!r.paidTag&&r.contactId);
const current=[];const currentTags=[];
for(let i=0;i<approved.length;i+=100){const ids=approved.slice(i,i+100).map(r=>r.contactId);const [a,b]=await Promise.all([db.from('contacts').select('id,psid,page_id').eq('page_id',pageId).in('id',ids),db.from('contact_tags').select('contact_id,tag_id').in('contact_id',ids)]);if(a.error||b.error)throw new Error(a.error?.message||b.error?.message);current.push(...a.data);currentTags.push(...b.data);}
const tagged=new Set(currentTags.map(t=>t.contact_id));const eligible=approved.filter(r=>!tagged.has(r.contactId)&&current.some(c=>c.id===r.contactId&&c.psid===r.psid));
const entries=eligible.map(r=>({contact_id:r.contactId,tag_id:paidTagId}));
const audit=eligible.map(r=>({psid:r.psid,contactId:r.contactId,name:r.name,conversationId:r.conversationId,reason:decisions[r.psid].reason,evidence:decisions[r.psid].evidenceIndexes.map(i=>{const m=r.messages[i];if(!m)throw new Error(`Missing evidence for ${r.name}`);return m;})}));
const stamp=new Date().toISOString().replace(/[:.]/g,'-');const auditPath=path.join(out,`tag-audit-${stamp}.json`);
fs.writeFileSync(auditPath,JSON.stringify({status:'prepared',pageId,paidTagId,entries:audit},null,2));
console.log(JSON.stringify({qualified:approved.length,currentlyUntagged:entries.length,skippedExistingTags:approved.length-entries.length,names:eligible.map(r=>r.name)}));
if(process.argv[2]!=='apply')process.exit(0);
if(entries.length){const {error}=await db.from('contact_tags').upsert(entries,{onConflict:'contact_id,tag_id',ignoreDuplicates:true});if(error)throw new Error(error.message);}
let verified=0;for(let i=0;i<entries.length;i+=100){const {data,error}=await db.from('contact_tags').select('contact_id').eq('tag_id',paidTagId).in('contact_id',entries.slice(i,i+100).map(e=>e.contact_id));if(error)throw new Error(error.message);verified+=data.length;}
if(verified!==entries.length)throw new Error('Tag verification count mismatch');
const completedAt=new Date().toISOString();fs.writeFileSync(auditPath,JSON.stringify({status:'verified',completedAt,pageId,paidTagId,entries:audit},null,2));
if(entries.length){const {error}=await db.from('page_activity_history').insert({page_id:pageId,actor_user_id:null,action_type:'bulk_tags_added',entity_type:'contacts',status:'completed',summary:`Added Paid / Availed Service to ${entries.length} previously untagged contacts after live conversation review`,target_count:entries.length,success_count:entries.length,failure_count:0,completed_at:completedAt,details:{source:'Live Facebook conversation review',reviewDate:'2026-09-15',tagIds:[paidTagId],contactIds:entries.map(e=>e.contact_id),criteria:'Confirmed payment, credited deposit on completed service, or documented availed service',auditFile:path.basename(auditPath)}});if(error)console.log('Activity log error: '+error.message);}
console.log(JSON.stringify({verifiedNewTags:verified}));

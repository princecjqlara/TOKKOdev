import fs from 'node:fs';const p='analysis-output/loki-2026-09-15/';const d=JSON.parse(fs.readFileSync(p+'review-decisions.json'));
for(const [id,idx,reason] of [
['28313715621553980',[92,115,123,129],'Deposit credited, client confirms paid; video delivered and correction requested'],
['28778341231758907',[148,150,158,160],'Commissioned video produced; final payment not established'],
['29019822284270481',[130,135,137,153,160,179],'Commissioned video produced with requested revisions; final payment not established'],
['37213030005007353',[207,211,212,227,269],'Commissioned video, balance billing and full package delivered']
])d[id]={qualifies:true,evidenceIndexes:idx,reason};
fs.writeFileSync(p+'review-decisions.json',JSON.stringify(d,null,2));

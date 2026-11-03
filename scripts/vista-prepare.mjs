import fs from 'node:fs';
const dir='analysis-output/vista-2026-09-15';fs.mkdirSync(dir,{recursive:true});
const replacements=[['loki-2026-09-15','vista-2026-09-15'],['loki-client-audit.mjs','vista-client-audit.mjs'],['1a4fc336-1530-4064-a2a2-f79b2b005772','142b8647-c785-4205-a558-5e0cb26d7151'],['85984cc5-a2fb-4912-ab37-6414c42e1fc1','c7564310-6b2d-4f09-ac48-b16f52aae9e8'],['781078668411527','725843003947429'],['Loki Media','Vista Media Agency'],['LOKI MEDIA','VISTA MEDIA AGENCY'],['Loki_Media_Clients','Vista_Media_Clients'],['%loki%','%vista%']];
for(const suffix of ['client-audit','live-review','client-details','review','secondary-review','final-screen','extra-screen','apply-tags','inspect-client','business-review','build-workbook-data']){
 const target=`scripts/vista-${suffix}.mjs`;if(fs.existsSync(target))continue;
 let s=fs.readFileSync(`scripts/loki-${suffix}.mjs`,'utf8');for(const [a,b]of replacements)s=s.replaceAll(a,b);
 s=s.replace(/ if\(c.psid==='27805586639104026'\)numbers=\['09750092806','09451753552'\];\r?\n/,'');
 fs.writeFileSync(target,s);
}
for(const name of ['review-decisions.json','business-supplements.json','reviewed-batches.json'])if(!fs.existsSync(dir+'/'+name))fs.writeFileSync(dir+'/'+name,name==='review-decisions.json'?'{}':'[]');
let py=fs.readFileSync('scripts/loki-create-workbook.py','utf8');for(const [a,b]of replacements)py=py.replaceAll(a,b);
py=py.replace('10 pre-existing paid/service tags preserved',"{d['meta']['baselinePaidTags']} pre-existing paid/service tags preserved");
fs.writeFileSync('scripts/vista-create-workbook.py',py);
console.log('Prepared isolated Vista review files');

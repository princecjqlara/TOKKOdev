import fs from 'node:fs';
const dir='analysis-output/loki-2026-09-15';fs.mkdirSync(dir,{recursive:true});
const replacements=[['azshinari-2026-09-15','loki-2026-09-15'],['azshinari-client-audit.mjs','loki-client-audit.mjs'],['d3f40d05-aa54-498e-bff7-e9c4410b7471','1a4fc336-1530-4064-a2a2-f79b2b005772'],['312cb4e3-e221-42df-9d03-742de5e2bbc8','85984cc5-a2fb-4912-ab37-6414c42e1fc1'],['656646850875530','781078668411527'],['Azshinari','Loki Media'],['%azsh%','%loki%']];
for(const suffix of ['client-audit','live-review','client-details','digest','secondary-review','final-screen','apply-tags','inspect-client','build-workbook-data']){
 const target=`scripts/loki-${suffix}.mjs`;if(fs.existsSync(target))continue;
 let s=fs.readFileSync(`scripts/azshinari-${suffix}.mjs`,'utf8');for(const [a,b]of replacements)s=s.replaceAll(a,b);fs.writeFileSync(target,s);
}
for(const name of ['review-decisions.json','business-supplements.json'])if(!fs.existsSync(dir+'/'+name))fs.writeFileSync(dir+'/'+name,name.startsWith('review')?'{}':'[]');
console.log('Prepared isolated Loki audit files');

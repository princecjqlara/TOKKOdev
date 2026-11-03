import fs from 'node:fs';
const dir='analysis-output/manawari-2026-09-15';fs.mkdirSync(dir,{recursive:true});
const replacements=[['vista-2026-09-15','manawari-2026-09-15'],['vista-client-audit.mjs','manawari-client-audit.mjs'],['142b8647-c785-4205-a558-5e0cb26d7151','b33a9b46-6470-48ed-bcfc-4235aa46f241'],['c7564310-6b2d-4f09-ac48-b16f52aae9e8','f325fe8b-43a6-4e44-8198-b6463694e948'],['725843003947429','619355471260631'],['Vista Media Agency','Manawari Studios'],['VISTA MEDIA AGENCY','MANAWARI STUDIOS'],['Vista_Media_Clients','Manawari_Studios_Clients'],['%vista%','%manawari%']];
for(const suffix of ['client-audit','live-review','client-details','review','bill-review','save-decisions','secondary-review','final-screen','extra-screen','apply-tags','inspect-client','business-review','build-workbook-data']){
 const target=`scripts/manawari-${suffix}.mjs`;if(fs.existsSync(target))continue;
 let s=fs.readFileSync(`scripts/vista-${suffix}.mjs`,'utf8');for(const [a,b]of replacements)s=s.replaceAll(a,b);
 fs.writeFileSync(target,s);
}
for(const name of ['review-decisions.json','business-supplements.json'])if(!fs.existsSync(dir+'/'+name))fs.writeFileSync(dir+'/'+name,name==='review-decisions.json'?'{}':'[]');
const target='scripts/manawari-create-workbook.py';if(!fs.existsSync(target)){let s=fs.readFileSync('scripts/vista-create-workbook.py','utf8');for(const [a,b]of replacements)s=s.replaceAll(a,b);fs.writeFileSync(target,s);}
console.log('Prepared Manawari live review');

import fs from 'node:fs';const p='analysis-output/azshinari-2026-09-15/';const rs=JSON.parse(fs.readFileSync(p+'live-records.json'));const byId=new Map(rs.map(r=>[r.psid,r]));const all=JSON.parse(fs.readFileSync(p+'business-supplements.json'));
const additions=[
['24951848964507332',77,'Blair Hotspring Resort — Blair 1 and Blair 2'],
['27425351410451790',45,'JNJ Hardware & Construction Supply / JNJ Roofing'],
['27814390474865554',267,'Miguel Real Estate Services (referred client)'],
['27841632762123044',94,'AJ Plumbing & Electrical Services'],
['37750148227903619',74,'AutoCheck PH'],
['27124891593873442',130,'Mang Jepweng [page script]'],
['27133526019676330',131,'RNJ Fitness Center – Centro Pacita [page script]'],
['28017863477877707',65,'WICONNECT Fiber Internet [page caption]'],
['28188372234093711',77,'PHINMA Maayo Tugbok [promoted property in script]'],
['29050065627935037',42,'E&A Customize Couch [page script]'],
['36856396107339698',660,'Hacienda Barbara Jurassic World [page script]'],
['37359224903724550',131,'Mae Ukay [page script]']
];
for(const [psid,index,business] of additions){const m=byId.get(psid).messages[index];if(!all.some(s=>s.psid===psid&&s.index===index))all.push({psid,index,business,date:m.date,messageId:m.id,sourceText:m.text,sender:m.sender});}
fs.writeFileSync(p+'business-supplements.json',JSON.stringify(all,null,2));
console.log({supplements:all.length});

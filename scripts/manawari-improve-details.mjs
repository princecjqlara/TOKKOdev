import fs from 'node:fs';let p='scripts/manawari-client-details.mjs';let s=fs.readFileSync(p,'utf8');s=s.replace('Business\\s*(?:Page\\s*Link|Name|Location|Type)?','Business\\s*(?:Page\\s*(?:/\\s*Social\\s*Media\\s*)?Link|Name|Location|Type)?').replace('Preferred\\s*(?:Video\\s*)?Length|Preferred\\s*Style','Preferred\\s*(?:Video\\s*)?Length(?:\\s*\\([^)]*\\))?|Preferred\\s*Style(?:\\s*/\\s*Inspiration)?(?:\\s*\\([^)]*\\))?');s=s.replace("if(Object.keys(fields).length)forms.push",`// Older briefs replace template labels with numbered answers.
   if(Object.keys(fields).length<3&&/^\\s*1[.)]\\s+/m.test(t)&&/^\\s*3[.)]\\s+/m.test(t)&&/^\\s*7[.)]\\s+/m.test(t)){
    const numbered=[...t.matchAll(/^\\s*(\\d+)[.)]\\s*([^\\n]*(?:\\n(?!\\s*\\d+[.)])[^\\n]*)*)/gm)];
    const keys={1:'Business Name',2:'Business Page Link',3:'Business Location',4:'Goal of Video',5:'Preferred Video Length',6:'Preferred Style',7:'Contacts Number',8:'Portrait or Landscape'};
    for(const n of numbered){const k=keys[n[1]],v=n[2].trim();if(k&&v&&!/^(?:Business Page|Social Media|Business Name|Business Location|Contacts|Preferred|Main Problem)/i.test(v))fields[k]=v;}
   }
   if(Object.keys(fields).length)forms.push`);fs.writeFileSync(p,s);
p='scripts/manawari-build-workbook-data.mjs';s=fs.readFileSync(p,'utf8').replace("'09604022339'","'09604022339','09666026458','09929410610','09944869941','09565603754','09663445733','09602863740'").replace('fields(/goal|purpose/i)','fields(/goal|purpose|main problem/i)');fs.writeFileSync(p,s);

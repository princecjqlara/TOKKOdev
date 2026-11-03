import fs from 'node:fs';
const dir='analysis-output/azshinari-2026-09-15/';
const decisions=JSON.parse(fs.readFileSync(dir+'review-decisions.json'));
const secondary=process.argv[2]==='--secondary';
const candidates=JSON.parse(fs.readFileSync(dir+(secondary?'secondary-candidates.json':'digest-candidates.json')));
const ids=new Set(process.argv.slice(secondary?3:2));
for(const r of candidates){if(!ids.has(r.psid))continue;if(decisions[r.psid])throw new Error('Decision already exists');decisions[r.psid]={qualifies:true,evidenceIndexes:r.evidence.map(e=>e.i),reason:[...new Set(r.evidence.map(e=>e.type))].join('; ')};}
fs.writeFileSync(dir+'review-decisions.json',JSON.stringify(decisions,null,2));console.log(`Saved ${ids.size} reviewed decisions`);

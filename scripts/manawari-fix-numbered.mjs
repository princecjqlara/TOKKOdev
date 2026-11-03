import fs from 'node:fs';const p='scripts/manawari-client-details.mjs';let s=fs.readFileSync(p,'utf8').replaceAll('[.)]\\s+','[.)]\\s*');fs.writeFileSync(p,s);

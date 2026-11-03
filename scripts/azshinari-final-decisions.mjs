import fs from 'node:fs';
const p='analysis-output/azshinari-2026-09-15/';const d=JSON.parse(fs.readFileSync(p+'review-decisions.json'));
const rows=[
['24516809688007190',[184,185],'Client states deposit paid for the agreed order'],
['24704848369215744',[92,93,95],'Deposit stated; page confirms production in progress'],
['24805661175721013',[103,104,107],'Commissioned video approved; balance requested; service availed'],
['26668586226150060',[31],'Client states description and payment already sent'],
['27133526019676330',[183,185,186],'Commissioned output checked; client states payment sent'],
['27437455952620410',[67,68,70],'Client states GCash deposit sent while awaiting production'],
['27606334269059289',[29,31],'Client states commissioned work was paid and asks about posting'],
['27633043893022168',[49,50,52],'Deposit stated and page confirms production'],
['27666560736315960',[137,138,140],'Deposit paid; customer raises service dispute; production acknowledged'],
['27690675620616904',[162,163,164,165],'Commissioned video approved; service availed; payment not confirmed'],
['27765379623119394',[64,65,67],'Deposit stated and editor confirms work in progress'],
['28031807519824312',[82,83,84],'Client states balance paid for commissioned video'],
['28188372234093711',[28,29,31],'Client confirms deposit sent and page starts briefing'],
['28266677676332861',[39,40,42],'Commissioned video delivered for approval; remaining balance stated'],
['28734785409444803',[168,169,170,171],'Full payment receipt requested and full copy delivered'],
['37342248542057198',[108,110,111],'Client states payment complete; page sends package'],
['37359224903724550',[200,202,218],'Commissioned video produced; client subsequently confirms paid, dissatisfied with results'],
['37750148227903619',[41,147,148,149],'Payment proof stated and commissioned video revisions requested'],
['25177587971842952',[470,472,530],'Existing tag corroborated: payment and satisfied commissioned client'],
['25531366943154624',[209,210,212],'Existing tag corroborated: commissioned revised output approved'],
['27187825520888375',[251,252,255,256],'Existing tag corroborated: paid and package delivered'],
['27521456094175148',[73,74,76],'Existing tag corroborated: balance sent and original delivered'],
['27936867995937985',[39,40,41],'Existing tag corroborated: deposit sent and video produced'],
['28242066048719594',[88,89],'Existing tag corroborated: deposit paid; service dissatisfaction'],
['24951848964507332',[106,113,116],'Existing tag corroborated: payment and completed resort advertisement'],
['27866850586261134',[493,494],'Existing tag corroborated: completed commissioned transaction acknowledged']
];
for(const [id,evidenceIndexes,reason] of rows)d[id]={qualifies:true,evidenceIndexes,reason};
fs.writeFileSync(p+'review-decisions.json',JSON.stringify(d,null,2));console.log('Recorded '+rows.length+' decisions');

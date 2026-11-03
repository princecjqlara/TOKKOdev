import fs from 'node:fs';
const p='analysis-output/azshinari-2026-09-15/';
// Each reviewed business name points to a message in the complete live history.
const rows=[
['25188352064155138',93,'ikulay'],['26765735363101526',32,'G.nemz driftwood coffee tree'],
['26809623768713742',40,'Liora Homes Naic (promoted property)'],['26861469260196560',53,'Bonnie beauty lounge and spa'],
['26997096149965148',57,'Juzaika Japan Surplus Bodega'],['27030389836664139',49,'Brix Motorcycle Spare Parts and Accessories'],
['27054148604267135',43,'Triwynn sportswear and Merchandising'],['27093014690374095',44,'Liwanag laundry shop'],['27093014690374095',39,'Liwanag Water Refilling Station'],
['27210225398678302',41,'Six ladies carinderia'],['27284588921222910',35,'CSML VARIETY STORE AND BEVERAGES TRADING'],
['27316064884727021',24,"Imperial Realin's group"],['27346499841685140',113,'Clickmoto — Taytay and Pasig branches'],
['27365062103142942',35,'Lyceum De Abuid Inc'],['27365062103142942',197,'Carl Jillian Business Center'],
['27367800662829247',71,'Thumbs up food hub'],['27469106522711789',32,"HAYDEE'S KTV and RESTOBAR"],
['27485413574473310',79,'Happy manok'],['27507319022254112',31,"Virgilio's Staycation"],
['27540457422272162',90,'Davic egg trading'],['27559607627039197',34,'Kakao Optical - Blueboz Taguig'],
['27571242422530965',29,'Belle Aesthetics'],['27583548057970735',26,'Dekada Aluminum and Glass Supply'],
['27625166240481301',48,'Honeywell Online Shop'],['27629130376745055',21,'KKJM MEATSHOP'],
['27636126376069291',6,"STAR 'N PENSION HOUSE"],['27711168495182605',70,"Npt ayuda’s meatshop"],
['27738772632457130',77,'Janmig auto detailing center'],['27760225400262041',30,'HYE ZEL LAUNDRY HUB'],
['27832563149732664',38,'HJ construction supply'],['27838137409183113',13,'Sinamak ni Lucas (product)'],
['27852029381157081',47,'Unwanted preg by Danica (page name)'],['27853524660910083',92,'Talentryve Virtual Services'],
['27857027123932918',31,'Gimeno Electrical Installation services'],['27857027123932918',92,'GGK AGRIVET SUPPLIES'],
['27859966533675923',19,'Mitsubishi Abad Santos (agent / promoted dealership)'],['27860151426927295',100,'Orantak electrical and services'],
['27861093136884076',36,'Megan$ alexis special pork chicharon'],['28006039945666492',34,'Pastil-An at iba pa.'],
['28019549481071289',61,'MainaVille'],['28035482126142815',33,'MMT TOP ROOFING CENTER'],
['28155783624108934',3,'Jepoy barbershop and salon'],['28170061039344332',4,'Dams lechon'],
['28187927954205151',36,'Ilao construction services'],['28215006371424474',37,'Daniel Car Aircon'],
['28318186711122781',246,'Iworld Wifi'],['28398371439748555',150,'Milk kefir (product; Nelia Quiñones)'],
['28444498541834114',10,"BODE's sari sari store"],['28461103546824291',35,'NextStep VA'],
['28578408265093268',98,'Country vege foods (reseller)'],['28580220614898955',37,'SAMASARAP Lutong Bahay'],
['28660538000196230',49,'APM birthing home'],['28770319345989371',7,'Kbahay Services'],
['28884910561101041',57,'Arlo Purified Water Station'],['28919966567606511',98,"Jan's chickens"],
['28930467286554350',37,'Queen Sole Shoes & Apparel'],['36631034276541194',27,'RVF FRUITS AND VEGETABLES'],
['36768418539470656',55,'Villa Joelita Park and Resort'],['36831167896529891',76,'3s cooking oil'],
['37101339706146400',373,'ACOY LAPAZ BATCHOY SURALLAH'],['37187349850879687',158,'Juan cafe'],
['37311599285120928',48,"Librada's Paluto"],['37332985129633053',67,'MANCAVE BARBERSHOP'],
['37357943220515589',50,'K_egg & sip up coffee'],['37822961217351424',5,'SMDC marketing partner (role; brand not supplied)'],
['38056333864011088',67,'UYY TAHO'],['38086920820955913',150,'ALVIN ALAG — homemade pork chorizo'],
['38200144796239197',178,'Bettylove Foods'],['39116233134642389',102,'ML STAINLESS STEEL FABRICATION']
];
const records=JSON.parse(fs.readFileSync(p+'live-records.json'));const byId=new Map(records.map(r=>[r.psid,r]));
const result=rows.map(([psid,index,business])=>{const r=byId.get(psid),m=r.messages[index];if(m.sender!=='contact')throw Error('Source is not client '+psid);return{psid,index,business,date:m.date,messageId:m.id,sourceText:m.text};});
fs.writeFileSync(p+'business-supplements.json',JSON.stringify(result,null,2));
const d=JSON.parse(fs.readFileSync(p+'review-decisions.json'));d['38350205934625145']={qualifies:true,evidenceIndexes:[100,108,109,112,113,114,115],reason:'Client confirms doctor paid; commissioned video approved and final files delivered'};fs.writeFileSync(p+'review-decisions.json',JSON.stringify(d,null,2));
console.log({businessSupplements:result.length});

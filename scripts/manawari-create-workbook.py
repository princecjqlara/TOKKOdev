import sys,json,math,re,zipfile,xml.etree.ElementTree as ET,shutil,textwrap
from pathlib import Path
from datetime import datetime
ROOT=Path(__file__).resolve().parent.parent
DATA=ROOT/'analysis-output/manawari-2026-09-15'
sys.path.insert(0,str(ROOT/'analysis-output/azshinari-2026-09-15/python-libs'))
import xlsxwriter
from PIL import Image,ImageDraw,ImageFont
d=json.loads((DATA/'workbook-data.json').read_text(encoding='utf-8'))
OUT=ROOT/'outputs/manawari-2026-09-15'
OUT.mkdir(parents=True,exist_ok=True)
dest=OUT/'Manawari_Studios_Clients_2026-09-15.xlsx'
w=xlsxwriter.Workbook(dest,{'strings_to_formulas':False,'strings_to_urls':False})
w.set_properties({'title':'Manawari Studios client register — 15 September 2026','subject':'Live conversation review and paid/service tagging','author':'Manawari Studios','comments':'Source: live Facebook conversation histories; Asia/Manila dates.'})
navy='#17324D';teal='#117C83';pale='#E9F3F5';gray='#526575'
base={'font_name':'Calibri','font_size':11,'valign':'top','font_color':'#243746'}
body=w.add_format({**base,'text_wrap':True});datefmt=w.add_format({**base,'num_format':'yyyy-mm-dd'});num=w.add_format({**base,'num_format':'#,##0'});money=w.add_format({**base,'num_format':'"PHP "#,##0.00'});link=w.add_format({**base,'font_color':'#12647B','text_wrap':True});hdr=w.add_format({**base,'bold':True,'font_color':'#FFFFFF','bg_color':navy,'text_wrap':True,'valign':'vcenter'});title=w.add_format({**base,'font_size':23,'bold':True,'font_color':'#FFFFFF','bg_color':navy});sub=w.add_format({**base,'font_color':gray,'text_wrap':True});warn=w.add_format({**base,'bg_color':'#FFF2CF','font_color':'#795C14','text_wrap':True});metric=w.add_format({**base,'bold':True,'font_size':20,'num_format':'#,##0','font_color':teal,'bg_color':pale});label=w.add_format({**base,'bg_color':pale,'text_wrap':True,'valign':'vcenter'});section=w.add_format({**base,'bold':True,'font_color':teal,'font_size':13})
summary=w.add_worksheet('Summary')
sheet_specs=[]
def split_rows(rows,col,maxlen=720):
 out=[]
 for r in rows:
  val=str(r[col] or '')
  parts=textwrap.wrap(val,maxlen,replace_whitespace=False,drop_whitespace=False,break_long_words=True) or ['']
  for i,part in enumerate(parts):
   rr=r.copy();rr[col]=part
   if len(parts)>1:rr[2]=str(rr[2])+f' (part {i+1}/{len(parts)})'
   out.append(rr)
 return out
def table(name,subtitle,headers,rows,widths,dates=(),nums=(),currency=()):
 widths=[max(70,ww) if 'URL' in headers[i] else ww for i,ww in enumerate(widths)]
 s=w.add_worksheet(name);s.hide_gridlines(2);s.set_zoom(85);s.freeze_panes(4,1);s.set_tab_color(teal)
 s.merge_range(0,0,0,min(len(headers)-1,5),name,title);s.set_row(0,38)
 s.merge_range(1,0,1,min(len(headers)-1,5),subtitle,sub);s.set_row(1,44)
 for i,ww in enumerate(widths):s.set_column(i,i,ww,body)
 s.set_row(3,60)
 cols=[]
 for j,h in enumerate(headers):cols.append({'header':h,'header_format':hdr,'format':datefmt if j in dates else num if j in nums else money if j in currency else body})
 if rows:s.add_table(3,0,3+len(rows),len(headers)-1,{'columns':cols,'style':'Table Style Medium 2','autofilter':True,'banded_rows':True})
 for ri,r in enumerate(rows,4):
  lines=1
  for ci,v in enumerate(r):
   if v is None or v=='':continue
   if ci in dates:
    s.write_datetime(ri,ci,datetime.strptime(v[:10],'%Y-%m-%d'),datefmt)
   elif isinstance(v,(int,float)):s.write_number(ri,ci,v,money if ci in currency else num)
   else:
    s.write_string(ri,ci,str(v),link if str(v).startswith('https://') else body)
    # URL and technical identifiers use a bounded height; their full value is stored.
    if 'ID' not in headers[ci] and 'PSID' not in headers[ci]:
     lines=max(lines,sum(max(1,math.ceil(len(x)/(widths[ci]*0.90))) for x in str(v).split('\n')))
  s.set_row(ri,min(300,max(30,lines*15+8)))
 for ci,h in enumerate(headers):
  if h in ('Message ID','Contact PSID','Conversation ID'):s.set_column(ci,ci,widths[ci],body,{'hidden':True})
 s.set_landscape();s.fit_to_pages(1,0);s.repeat_rows(0,3);s.set_paper(9);s.set_margins(.3,.3,.4,.4);s.set_footer('&LManawari Studios · 15 Sep 2026&RPage &P of &N')
 sheet_specs.append((name,len(rows),headers,widths))
 return s
clients=[r.copy() for r in d['clients']]
for r in clients:
 for c in (4,5,6,18):
  if isinstance(r[c],str) and len(r[c])>720:r[c]=r[c][:640]+'… [Full wording in Business History]'
table('Clients','Supported paid or availed-service contacts. Start/end fields show documented production updates and deliveries; they can refer to different orders. Blank = unknown. See Service History.',
 ['Client name','Business / brand / promoted project','Contact numbers mentioned','Emails supplied / script-sourced','Locations / addresses supplied','Business goals','Video lengths requested','Started — documented production','Ended — documented final delivery','First reviewed service evidence','First message','Latest message','Evidence classification','Tag result','New tag date','Messages reviewed','Source conversation URL','Contact PSID','Products / services supplied','Links shared by client','Business hours supplied','Other contact person','Qualification / status notes'],clients,[32,48,27,34,50,52,24,20,20,20,18,18,34,28,18,16,45,25,60,70,30,30,60],dates=(7,8,9,10,11,14),nums=(15,))
table('Business History','Dated business briefs, contact details, corrections and client-shared links from full text histories. Client wording is preserved; sales claims and link ownership are not independently verified.',
 ['Client name','Message date','Detail / field','Detail value / original wording','Sender','Message ID','Source conversation URL','Contact PSID'],split_rows(d['history'],3),[32,18,38,105,15,30,45,25],dates=(1,))
table('Service History','Production updates, documented final deliveries and reviewed payment/service evidence. Multiple orders can share one conversation. Delivery does not establish the end of every engagement.',
 ['Client name','Event date','Event type','Message / evidence','Message ID','Source conversation URL','Contact PSID'],split_rows(d['events'],3),[32,18,40,105,30,45,25],dates=(1,))
table('Tag Evidence','Source evidence for inclusion. Payment requests alone do not mean fully paid; commissioned production qualifies as availed service. Existing uncorroborated tags are in Review Needed.',
 ['Client name','Evidence date','Qualification reason','Supporting message','Sender','Message ID','Source conversation URL','Contact PSID'],split_rows(d['evidence'],3),[32,18,52,100,15,30,45,25],dates=(1,))
bills=[]
for r in d['billing']:
 rr=r.copy()
 for c in (2,3,4,5):
  v=str(rr[c]).strip()
  if re.fullmatch(r'(?:PHP\s*|₱\s*)?[\d,]+(?:\.\d{1,2})?',v,re.I):rr[c]=float(re.sub(r'[^\d.]','',v))
 bills.append(rr)
table('Billing History','Historical quoted amounts, preserved by message date. Do not sum as revenue or current debt: quotes may be revised, duplicated or later paid. Mixed package descriptions remain text.',
 ['Client name','Bill message date','Deposit quoted (PHP)','Package amount / description','Revision fee (PHP)','Balance quoted (PHP)','Interpretation','Original billing message','Message ID','Source conversation URL','Contact PSID'],bills,[32,18,23,38,23,24,46,90,30,45,25],dates=(1,),currency=(2,3,4,5))
review=table('Review Needed','Existing uncorroborated tags are retained for your review. Other rows are ambiguous candidates with no new tag. This is not a list of confirmed clients.',
 ['Contact name','Review status','First message','Latest message','Message count','Reason / next check','Source conversation URL','Contact PSID'],d['review'],[32,42,18,18,18,80,45,25],dates=(2,3),nums=(4,))
review.conditional_format(4,1,3+len(d['review']),1,{'type':'text','criteria':'containing','value':'Existing','format':warn})
table('Coverage','Every live conversation fetched, plus database contacts with no returned conversation. All text was screened; selected payment/service and business context was reviewed. Attachment contents were not inspected.',
 ['Contact name','Contact PSID','Message count','First message','Latest message','Review outcome','Tag state at review','Conversation ID'],d['coverage'],[34,26,20,18,18,48,36,40],dates=(3,4),nums=(2,))
# Compact, formula-driven overview.
summary.hide_gridlines(2);summary.set_zoom(95);summary.set_column('A:A',3);summary.set_column('B:B',38);summary.set_column('C:C',18);summary.set_column('D:D',3);summary.set_column('E:E',38);summary.set_column('F:F',18);summary.set_column('G:G',3)
summary.merge_range('B2:F3','MANAWARI STUDIOS | CLIENT REGISTER',title)
summary.merge_range('B5:F5','Live conversation review • 15 September 2026 • Asia/Manila',sub)
n=len(clients)+4;cv=len(d['coverage'])+4
metrics=[(6,'Supported client contacts',f"=COUNTA('Clients'!A5:A{n})",len(clients),'New tags verified',f'=COUNTIF(\'Clients\'!N5:N{n},"New tag verified")',d['meta']['newTags']),
 (9,'Live conversations returned',f'=COUNTIF(\'Coverage\'!F5:F{cv},"<>No available live conversation returned")',d['meta']['liveConversations'],'Messages downloaded',f"=SUM('Coverage'!C5:C{cv})",d['meta']['messages']),
 (12,'Existing tags needing review',f'=COUNTIF(\'Review Needed\'!B5:B{len(d["review"])+4},"Existing*")',d['meta']['legacyReview'],'Database contacts without live chat',f'=COUNTIF(\'Coverage\'!F5:F{cv},"No available live conversation returned")',d['meta']['missingLive'])]
for row,l1,f1,v1,l2,f2,v2 in metrics:
 summary.write(row,1,l1,label);summary.write_formula(row,2,f1,metric,v1);summary.write(row,4,l2,label);summary.write_formula(row,5,f2,metric,v2);summary.set_row(row,49)
summary.merge_range('B16:F16','How to use this register',section)
notes=[
 'Completed 16 September 2026. Register dated 15 September reflects the start of this live-history review.',
 'Details marked as production-script sources come from agency messages; client image/attachment briefs were not inspected.',
 'Clients: confirmed payment/deposit evidence or documented commissioned service. The combined Paid / Availed Service tag does not mean every client is fully paid.',
 'Business History: follow dated briefs and corrections. One contact can represent several businesses, clients, branches or promoted properties; ownership is not assumed.',
 'Dates: Started is the first explicit production update found; Ended is the latest final delivery found. They can refer to different orders; they are not a matched project duration. Blank = unknown.',
 'Billing History: amounts are quoted in historical messages. They are not verified receipts, cumulative revenue or current receivables.',
 f"Coverage: {d['meta']['liveConversations']:,} live conversations and {d['meta']['messages']:,} messages. All available text pages were downloaded and screened; candidate context was reviewed. Attachment contents were not reviewed.",
 'Limitations: receipt images, other attachments, voice recordings, external Telegram/Viber exchanges and inaccessible/deleted messages were not inspected. Some business names or dates therefore remain unknown.',
 f"Reconciliation: the database snapshot had {d['meta']['databaseContacts']:,} contacts; {d['meta']['missingLive']} had no returned live conversation. No new tag was applied without a matching database contact.",
 f"Scope: live Facebook API histories through the existing Tokko connection. {d['meta']['newTags']} new tags verified; {d['meta']['baselinePaidTags']} pre-existing paid/service tags preserved, including {d['meta']['legacyReview']} awaiting corroboration."
]
for i,t in enumerate(notes,17):summary.merge_range(i,1,i,5,t,sub);summary.set_row(i,54 if len(t)>225 else 44)
summary.merge_range('B29:F29','Blank = not established from available text. Review Needed rows are excluded from the supported Clients list.',warn);summary.set_row(28,40)
summary.set_portrait();summary.fit_to_pages(1,1);summary.print_area('B2:F29');summary.set_paper(9)
w.get_worksheet_by_name('Clients').activate()
w.close()
# Validate the actual saved OOXML: counts, cached formulas, dates, IDs and corruption.
ns={'m':'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
with zipfile.ZipFile(dest) as z:
 assert z.testzip() is None
 ss=ET.fromstring(z.read('xl/sharedStrings.xml'));strings=[''.join(si.itertext()) for si in ss]
 sheets=[]
 for i in range(1,9):
  root=ET.fromstring(z.read(f'xl/worksheets/sheet{i}.xml'));rows=[]
  for row in root.findall('.//m:sheetData/m:row',ns):
   rr={}
   for c in row.findall('m:c',ns):
    v=c.find('m:v',ns);value=v.text if v is not None else ''
    if c.attrib.get('t')=='s':value=strings[int(value)]
    assert c.attrib.get('t')!='e',('Excel error',value)
    rr[c.attrib['r']]=value
   rows.append(rr)
  sheets.append(rows)
 assert len(sheets[1])-3==len(clients),(len(sheets[1]),len(clients))
 summary_values={k:v for row in sheets[0] for k,v in row.items()}
 assert summary_values['C7']==str(len(clients))
 assert summary_values['F7']==str(d['meta']['newTags'])
 assert summary_values['F10']==str(d['meta']['messages'])
 # Make visual previews directly from saved worksheet values. Native Excel renderer unavailable.
 font=ImageFont.truetype('C:/Windows/Fonts/calibri.ttf',16);bold=ImageFont.truetype('C:/Windows/Fonts/calibrib.ttf',18)
 previews=[]
 names=['Summary']+[s[0] for s in sheet_specs]
 for idx,rows in enumerate(sheets):
  im=Image.new('RGB',(1440,800),'white');draw=ImageDraw.Draw(im);draw.rectangle((0,0,1440,55),fill=navy);draw.text((20,16),names[idx]+' — saved workbook values',font=bold,fill='white')
  if idx==0:
   display=[]
   for row in rows:
    vals=[v for k,v in row.items() if v]
    if vals:display.append('   |   '.join(vals))
   y=70
   for line in display[:17]:
    t='\n'.join(textwrap.wrap(line,140));draw.multiline_text((22,y),t,font=font,fill=navy,spacing=4);y+=max(30,22*(t.count('\n')+1))+9
  else:
   vals=[r for r in rows if any(re.match(r'[A-Z]+4$',k) for k in r)]
   header=vals[0];data=[r for r in rows if any(re.match(r'[A-Z]+[5-9]$',k) for k in r)][:4]
   columns=[re.sub(r'\d','',k) for k in header][:4];widths=[260,180,320,640]
   y=75
   for j,row in enumerate([header]+data):
    h=72 if j==0 else 155;x=20
    for col,ww in zip(columns,widths):
     txt=next((v for k,v in row.items() if re.sub(r'\d','',k)==col),'')
     if j>0 and ((col=='B' and names[idx] in ('Business History','Service History','Tag Evidence','Billing History')) or (col in ('C','D') and names[idx]=='Review Needed') or (col=='D' and names[idx]=='Coverage')) and str(txt).isdigit():
      from datetime import timedelta
      txt=(datetime(1899,12,30)+timedelta(days=int(txt))).strftime('%Y-%m-%d')
     draw.rectangle((x,y,x+ww,y+h),fill=navy if j==0 else ('#E9F3F5' if j%2 else '#F6F8FA'))
     lines=textwrap.wrap(str(txt),max(12,int(ww/8)))[:6]
     draw.multiline_text((x+10,y+10),'\n'.join(lines),font=font,fill='white' if j==0 else navy,spacing=3);x+=ww
    y+=h+2
  pp=OUT/f'preview-{idx+1}.png';im.save(pp);previews.append(str(pp))
report={'file':str(dest),'sheets':[{ 'name':n,'dataRows':len(sheets[i])-3 if i else None} for i,n in enumerate(names)],'confirmedClients':len(clients),'newTags':d['meta']['newTags'],'formulaErrors':0,'zipIntegrity':'passed','nativeExcelRendering':'unavailable; saved-value previews generated','previews':previews}
(OUT/'verification.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
print(json.dumps(report,ensure_ascii=False))

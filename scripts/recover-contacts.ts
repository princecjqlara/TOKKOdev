// Imports Page contacts only. Never invokes campaign or outbound messaging code.
// Invoked by recover-contacts.mjs using the application's shared worker.
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import nextEnv from '@next/env';
nextEnv.loadEnvConfig(process.cwd());
const { getSupabaseAdmin } = await import('../src/lib/supabase');
const { databaseRequest } = await import('../src/lib/database-request');
const { processContactImport } = await import('../src/lib/contact-import');
const args=process.argv.slice(2);
if (!args.includes('--apply') || !args.includes('--all-pages') && !args.includes('--page-id')) {
    throw Error('Use --apply and either --all-pages or --page-id <UUID>. This writes imported contacts and saved checkpoints.');
}
const db=getSupabaseAdmin();
let pagesQuery=db.from('pages').select('id,name').order('name');
if(args.includes('--page-id'))pagesQuery=pagesQuery.eq('id',args[args.indexOf('--page-id')+1]);
const {data:pages,error}=await databaseRequest(pagesQuery);
if(error)throw Error('Could not read the selected Pages.');
async function count(pageId:string){
    const result=await databaseRequest(db.from('contacts').select('id',{count:'exact',head:true}).eq('page_id',pageId));
    if(result.error)throw Error('Contact count could not be verified.');return result.count||0;
}
const path='outputs/contact-import-recovery.json';fs.mkdirSync('outputs',{recursive:true});
const report:{startedAt:string;finishedAt?:string;customerMessagesSent:number;pages:any[];passed?:boolean}=
    args.includes('--resume')&&fs.existsSync(path)?JSON.parse(fs.readFileSync(path,'utf8')):{startedAt:new Date().toISOString(),customerMessagesSent:0,pages:[]};
function save(){fs.writeFileSync(path,JSON.stringify(report,null,2));}
let index=0;
async function work(){
    while(index<(pages||[]).length){
        const page=pages![index++];
        const previous=report.pages.find(entry=>entry.pageId===page.id);
        if(previous?.completed)continue;
        const entry:any=previous||{pageId:page.id,pageName:page.name,before:await count(page.id),processed:0,completed:false};
        let run=entry.runId||randomUUID();let failures=0,lastProgress=Date.now();
        if(!previous)report.pages.push(entry);delete entry.error;save();
        for(let slice=0;slice<100000;slice++){
            try{
                const result=await processContactImport({pageId:page.id,syncRunId:run,autoTag:args.includes('--with-tags'),supabase:db});
                if(!('totalSynced' in result))throw Error('The worker did not return its saved progress.');
                run=result.syncRunId||run;entry.runId=run;
                if(result.totalSynced!==entry.processed){lastProgress=Date.now();failures=0;}
                entry.processed=result.totalSynced;entry.folder=result.folder;
                if(slice%25===0){console.log(JSON.stringify({page:page.name,saved:entry.processed,folder:entry.folder}));save();}
                if(!result.partial){entry.completed=true;entry.after=await count(page.id);entry.added=entry.after-entry.before;break;}
                if(Date.now()-lastProgress>5*60_000)throw Error('Import remains queued; its saved checkpoint can be resumed.');
                if(result.waiting)await new Promise(resolve=>setTimeout(resolve,2000));
            }catch(error){
                const failure=error as {status?:number;message?:string};
                if(failure.status===503&&++failures<=5){await new Promise(resolve=>setTimeout(resolve,5000*failures));continue;}
                entry.error=failure.status===403?'Facebook reconnection required':failure.message||'Import could not continue';
                entry.after=await count(page.id);entry.added=entry.after-entry.before;break;
            }
        }
        console.log(JSON.stringify({page:page.name,completed:entry.completed,before:entry.before,after:entry.after,added:entry.added,error:entry.error}));save();
    }
}
await Promise.all([work(),work()]);report.finishedAt=new Date().toISOString();report.passed=report.pages.every(page=>page.completed);save();
console.log(JSON.stringify({finishedAt:report.finishedAt,completedPages:report.pages.filter(page=>page.completed).length,
    totalPages:report.pages.length,added:report.pages.reduce((sum,page)=>sum+(page.added||0),0),report:path,customerMessagesSent:0}));
if(!report.passed)process.exitCode=1;

import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest';
const mocks=vi.hoisted(()=>({getBatch:vi.fn(),tagger:vi.fn(),db:vi.fn()}));
vi.mock('../facebook',()=>({getPageConversationsBatch:mocks.getBatch,isFacebookReauthRequired:(error:any)=>error.code===190}));
vi.mock('../supabase',()=>({getSupabaseAdmin:mocks.db}));
vi.mock('../messaging-auto-tag-sync',()=>({createContactMessagingAutoTagger:()=>mocks.tagger}));
import { processContactImport } from '../contact-import';
const run='00000000-0000-4000-8000-000000000001';
function fixture(options:{folder?:string;cursor?:string|null;autoTag?:boolean;busy?:boolean;status?:string;saveError?:any;total?:number}={}){
    const job={page_id:'page',run_id:run,status:options.status||'queued',folder:options.folder||'inbox',cursor:options.cursor||null,
        processed_count:options.total||0,started_at:'2026-11-06T00:00:00Z',retry_after:null,last_error:null,
        fb_page_id:'facebook-page',access_token:'private-token',auto_tag:options.autoTag!==false,messaging_auto_tag_enabled:true};
    const update=vi.fn(); const chain:any={eq:()=>chain,then:(resolve:any)=>Promise.resolve({error:null}).then(resolve)};
    const db={rpc:vi.fn(async(name:string,args:any)=>{
        if(name==='request_contact_import')return {data:[job],error:null};
        if(name==='claim_contact_import')return {data:options.busy?[]:[job],error:null};
        if(name==='finish_contact_import_slice')return options.saveError?{data:null,error:options.saveError}:{data:[{...job,
            status:args.p_next_folder?'queued':'completed',folder:args.p_next_folder||job.folder,cursor:args.p_next_cursor,
            processed_count:job.processed_count+args.p_contacts.length}],error:null};
        if(name==='release_page_sync_lease')return {data:true,error:null};
        throw Error(`Unexpected RPC ${name}`);
    }),from:vi.fn(()=>({update:(payload:any)=>{update(payload);return chain;}}))};
    mocks.db.mockReturnValue(db);return {db,job,update};
}
const thread=(psid:string,name='Customer',messages:any[]=[])=>({id:`thread-${psid}`,updated_time:'2026-11-05T01:00:00Z',
    participants:{data:[{id:'facebook-page',name:'Page'},{id:psid,name}]},messages:{data:messages}});
beforeEach(()=>{vi.clearAllMocks();mocks.getBatch.mockResolvedValue({conversations:[],nextCursor:null});mocks.tagger.mockResolvedValue(false);});
afterEach(()=>{vi.useRealTimers();});
describe('durable imports across Messenger folders',()=>{
    it.each([['inbox','other'],['other','page_done'],['page_done','spam'],['spam',null]])('completes %s before moving to %s',async(folder,next)=>{
        const {db}=fixture({folder,autoTag:false});
        const result=await processContactImport({pageId:'page',syncRunId:run});
        expect(mocks.getBatch).toHaveBeenCalledWith('facebook-page','private-token',expect.objectContaining({folder,limit:500}));
        expect(db.rpc).toHaveBeenCalledWith('finish_contact_import_slice',expect.objectContaining({p_next_folder:next,p_next_cursor:null}));
        expect(result.partial).toBe(next!==null);
    });
    it('follows a short or empty cursor page instead of treating it as the end of the folder',async()=>{
        const {db}=fixture({cursor:'current',autoTag:false});
        mocks.getBatch.mockResolvedValue({conversations:[],nextCursor:'next'});
        const result=await processContactImport({pageId:'page'});
        expect(result).toMatchObject({partial:true,cursor:'next',folder:'inbox'});
        expect(db.rpc).toHaveBeenCalledWith('finish_contact_import_slice',expect.objectContaining({p_next_folder:'inbox',p_next_cursor:'next'}));
    });
    it('saves a full 100-contact page without individual profile or history requests',async()=>{
        const {db}=fixture({autoTag:false,total:1000});
        mocks.getBatch.mockResolvedValue({conversations:Array.from({length:100},(_,i)=>thread(`psid-${i}`)),nextCursor:'next'});
        const result=await processContactImport({pageId:'page'});
        expect(result).toMatchObject({synced:100,totalSynced:1100,partial:true,durable:true});
        expect(db.rpc.mock.calls.find(([name])=>name==='finish_contact_import_slice')![1].p_contacts).toHaveLength(100);
        expect(mocks.getBatch).toHaveBeenCalledTimes(1); expect(mocks.tagger).not.toHaveBeenCalled();
    });
    it('deduplicates contacts, skips groups, normalizes placeholder names, and retains inbound timestamps',async()=>{
        const {db}=fixture();
        mocks.getBatch.mockResolvedValue({conversations:[thread('psid','UNKNOWN',[{id:'inbound',from:{id:'psid',name:'Real Name'},created_time:'2026-11-05T00:00:00Z'}]),
            thread('psid','UNKNOWN'),{...thread('group'),participants:{data:[{id:'a'},{id:'b'}]}}],nextCursor:null});
        await processContactImport({pageId:'page'});
        const contacts=db.rpc.mock.calls.find(([name])=>name==='finish_contact_import_slice')![1].p_contacts;
        expect(contacts).toHaveLength(1);expect(contacts[0]).toMatchObject({psid:'psid',name:'Real Name',last_inbound_at:'2026-11-05T00:00:00.000Z'});
    });
    it('resumes a running job even if a different browser supplied a new run ID',async()=>{
        fixture({folder:'page_done',cursor:'saved',autoTag:false,total:1200});
        const result=await processContactImport({pageId:'page',syncRunId:'00000000-0000-4000-8000-000000000002'});
        expect(mocks.getBatch).toHaveBeenCalledWith('facebook-page','private-token',expect.objectContaining({folder:'page_done',after:'saved'}));
        expect(result).toMatchObject({syncRunId:run,totalSynced:1200});
    });
    it('waits for an overlapping worker without starting another Facebook request',async()=>{
        fixture({busy:true,total:100});
        const result=await processContactImport({pageId:'page',syncRunId:run});
        expect(result).toMatchObject({waiting:true,partial:true,totalSynced:100});expect(mocks.getBatch).not.toHaveBeenCalled();
    });
    it('returns an already completed run without importing it twice',async()=>{
        fixture({status:'completed',total:1000});
        const result=await processContactImport({pageId:'page',syncRunId:run});
        expect(result).toMatchObject({partial:false,totalSynced:1000});expect(mocks.getBatch).not.toHaveBeenCalled();
    });
    it('retains the saved cursor on a rate limit instead of dropping the remainder of a folder',async()=>{
        const {db,update}=fixture({cursor:'saved'});
        mocks.getBatch.mockRejectedValue(Object.assign(new Error('Rate limited'),{code:613}));
        await expect(processContactImport({pageId:'page'})).rejects.toMatchObject({status:503});
        expect(update).toHaveBeenCalledWith(expect.objectContaining({status:'queued',retry_after:expect.any(String)}));
        expect(db.rpc.mock.calls.some(([name])=>name==='finish_contact_import_slice')).toBe(false);
    });
    it('blocks expired Page tokens with an explicit reconnection action',async()=>{
        const {update}=fixture(); mocks.getBatch.mockRejectedValue(Object.assign(new Error('Expired'),{code:190}));
        await expect(processContactImport({pageId:'page'})).rejects.toMatchObject({status:403});
        expect(update).toHaveBeenCalledWith(expect.objectContaining({status:'blocked',last_error:expect.stringContaining('Reconnect')}));
    });
    it('cannot advance the cursor if saving the contact batch fails',async()=>{
        const {update}=fixture({saveError:{code:'57014',message:'statement timeout'}});
        mocks.getBatch.mockResolvedValue({conversations:[thread('psid')],nextCursor:'not-saved'});
        await expect(processContactImport({pageId:'page'})).rejects.toMatchObject({status:503});
        expect(update).toHaveBeenCalledWith(expect.objectContaining({status:'queued'}));expect(mocks.tagger).not.toHaveBeenCalled();
    });
    it('saves import progress before tag work and continues if tag writes fail',async()=>{
        const {db}=fixture();mocks.getBatch.mockResolvedValue({conversations:[thread('psid')],nextCursor:'next'});mocks.tagger.mockRejectedValue(new Error('Tag unavailable'));
        const result=await processContactImport({pageId:'page'});
        expect(result).toMatchObject({synced:1,tagFailures:1,partial:true});
        const index=db.rpc.mock.calls.findIndex(([name])=>name==='finish_contact_import_slice');
        expect(db.rpc.mock.invocationCallOrder[index]).toBeLessThan(mocks.tagger.mock.invocationCallOrder[0]);
    });
});

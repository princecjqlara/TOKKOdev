import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks=vi.hoisted(()=>({rpc:vi.fn()}));
vi.mock('@/lib/supabase',()=>({getSupabaseAdmin:()=>({rpc:mocks.rpc})}));
import { GET } from './route';
beforeEach(()=>{vi.clearAllMocks();});
describe('temporary subaccount cleanup worker',()=>{
    it('runs a bounded deletion batch and reports its outcome',async()=>{
        mocks.rpc.mockResolvedValue({data:{deleted:2,failed:0},error:null});
        const response=await GET();
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({success:true,deleted:2,failed:0});
        expect(mocks.rpc).toHaveBeenCalledWith('tokko_delete_expired_subaccounts',{p_limit:100});
    });
    it('does not report success when any deletion is blocked',async()=>{
        mocks.rpc.mockResolvedValue({data:{deleted:1,failed:1},error:null});
        expect((await GET()).status).toBe(503);
    });
    it('fails closed when the database is unavailable or returns an invalid result',async()=>{
        mocks.rpc.mockResolvedValue({data:null,error:{code:'PGRST202'}});
        expect((await GET()).status).toBe(503);
        mocks.rpc.mockResolvedValue({data:null,error:null});
        expect((await GET()).status).toBe(503);
    });
});

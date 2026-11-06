import { beforeEach,describe,expect,it,vi } from 'vitest';
import type { NextRequest } from 'next/server';
import { AccessError } from '@/lib/account-security';
const mocks=vi.hoisted(()=>({ process:vi.fn() }));
vi.mock('@/lib/contact-import',()=>({ processContactImport:mocks.process }));
import { GET } from './route';
const request=new Request('http://localhost/api/cron/sync') as NextRequest;
beforeEach(()=>{vi.clearAllMocks();});
describe('durable scheduled contact imports',()=>{
    it('continues the saved folder and cursor instead of fetching only the latest five conversations',async()=>{
        mocks.process.mockResolvedValue({success:true,durable:true,partial:true,synced:100,totalSynced:1200,folder:'other'});
        const response=await GET(request);
        expect(response.status).toBe(200);
        expect(mocks.process).toHaveBeenCalledOnce();
        expect(await response.json()).toMatchObject({success:true,results:[{partial:true,totalSynced:1200,folder:'other'}]});
    });
    it('reports a failed slice and preserves its retryable checkpoint',async()=>{
        mocks.process.mockRejectedValue(new AccessError(503,'Saved checkpoint retained'));
        const response=await GET(request);
        expect(response.status).toBe(503);
        expect(await response.json()).toMatchObject({success:false,message:'Saved checkpoint retained'});
    });
});

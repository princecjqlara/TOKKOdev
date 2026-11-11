import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { acquirePageDelivery, recordPageCampaignQuotaIdentity, reportPageDeliveryFeedback } from '../page-delivery';

describe('shared campaign quota metadata', () => {
    it('records the verified Facebook subject against a token fingerprint without sending the raw token to the RPC', async () => {
        const rpc=vi.fn().mockResolvedValue({data:true,error:null});
        await recordPageCampaignQuotaIdentity({rpc} as never,'page','private-token','123');
        expect(rpc).toHaveBeenCalledWith('record_page_campaign_quota_identity',{
            p_page_id:'page',p_token_fingerprint:createHash('sha256').update('private-token').digest('hex'),p_facebook_user_id:'123'
        });
        expect(JSON.stringify(rpc.mock.calls)).not.toContain('private-token');
    });

    it('does not infer a Facebook owner from an internal Tokko identifier', async () => {
        const rpc=vi.fn();
        await recordPageCampaignQuotaIdentity({rpc} as never,'page','token','tokko-employee-id');
        expect(rpc).not.toHaveBeenCalled();
    });

    it('reports all observed quota groups and independent provider deadlines in one feedback call', async () => {
        const rpc=vi.fn().mockResolvedValue({data:{owned:true,concurrency:5,interval_ms:1000,retry_at:null,growth_after:null},error:null});
        const now=Date.now();
        await reportPageDeliveryFeedback({rpc} as never,'page','lease',{
            concurrency:5,intervalMs:1000,limited:true,providerRetryAt:now+180_000,scope:'user',
            businessKeys:new Set(['123:messenger','invalid']),quotaTargets:new Map([
                ['user',{scope:'user',providerRetryAt:now+120_000}],
                ['business',{scope:'business',key:'123:messenger',providerRetryAt:now+180_000}]
            ])
        });
        const context=JSON.parse(rpc.mock.calls[0][1].p_scope);
        expect(context).toMatchObject({scope:'user',businessKeys:['123:messenger']});
        expect(context.targets).toHaveLength(2);
        expect(context.targets[0].retryAfterMs).toBeGreaterThan(119_000);
        expect(context.targets[1].retryAfterMs).toBeGreaterThan(179_000);
    });

    it('returns a busy wait separately from a provider cooldown', async () => {
        const rpc=vi.fn().mockResolvedValue({data:{acquired:false,reason:'busy',retry_at:'2026-11-11T00:00:02Z',batch_size:1},error:null});
        expect(await acquirePageDelivery({rpc} as never,'page')).toMatchObject({acquired:false,reason:'busy'});
        expect(rpc.mock.calls[0][0]).toBe('acquire_page_campaign_delivery_v2');
    });
});

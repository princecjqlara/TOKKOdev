import { afterEach, describe, expect, it, vi } from 'vitest';
import { waitForFacebookSendSlot } from '../facebook-send-pacing';
afterEach(()=>{vi.useRealTimers();});

describe('provider send ceilings',()=>{
    it('spaces fast text starts even when all operations complete immediately',async()=>{
        vi.useFakeTimers();const starts:number[]=[];
        const pending=Promise.all(Array.from({length:500},async()=>{
            await waitForFacebookSendSlot('text-fixture');starts.push(Date.now());
        }));
        await vi.runAllTimersAsync();await pending;
        expect(starts.slice(1).every((time,i)=>time-starts[i]>=4)).toBe(true);
        expect(starts[starts.length-1]-starts[0]).toBe(1996);
        expect(vi.getTimerCount()).toBe(0);
    });
    it('keeps audio/video starts within ten per second without delaying another Page',async()=>{
        vi.useFakeTimers();const media:number[]=[],other:number[]=[];
        const pending=Promise.all(Array.from({length:20},async()=>{
            await waitForFacebookSendSlot('media-fixture',true);media.push(Date.now());
        }).concat(Array.from({length:20},async()=>{
            await waitForFacebookSendSlot('other-fixture');other.push(Date.now());
        })));
        await vi.runAllTimersAsync();await pending;
        expect(media.slice(1).every((time,i)=>time-media[i]>=100)).toBe(true);
        expect(other[other.length-1]-other[0]).toBe(76);
        expect(vi.getTimerCount()).toBe(0);
    });
});

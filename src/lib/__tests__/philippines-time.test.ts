import { describe, expect, it } from 'vitest';
import {
    getNextPhilippinesScheduledAtIso,
    getPhilippinesDatePartsFromDateString,
    getPhilippinesHour,
    getPhilippinesScheduledAtIso,
    getTomorrowPhilippinesDateParts
} from '../philippines-time';

describe('philippines-time', () => {
    it('converts UTC timestamps into Philippine local hours', () => {
        expect(getPhilippinesHour(new Date('2026-07-29T01:00:00.000Z'))).toBe(9);
        expect(getPhilippinesHour(new Date('2026-07-29T18:00:00.000Z'))).toBe(2);
    });

    it('builds UTC schedule timestamps from Philippine local date and hour', () => {
        expect(
            getPhilippinesScheduledAtIso(9, {
                year: 2026,
                month: 6,
                day: 30
            })
        ).toBe('2026-07-30T01:00:00.000Z');
    });

    it('uses the next Philippine calendar day for next-day scheduling', () => {
        const dateParts = getTomorrowPhilippinesDateParts(new Date('2026-07-29T18:30:00.000Z'));

        expect(dateParts).toEqual({
            year: 2026,
            month: 6,
            day: 31
        });
    });

    it('finds the next occurrence of a Philippine local hour', () => {
        expect(getNextPhilippinesScheduledAtIso(9, new Date('2026-07-29T00:30:00.000Z')))
            .toBe('2026-07-29T01:00:00.000Z');
        expect(getNextPhilippinesScheduledAtIso(9, new Date('2026-07-29T01:30:00.000Z')))
            .toBe('2026-07-30T01:00:00.000Z');
    });

    it('parses date-input strings as Philippine calendar dates', () => {
        expect(getPhilippinesDatePartsFromDateString('2026-07-30')).toEqual({
            year: 2026,
            month: 6,
            day: 30
        });
    });
});

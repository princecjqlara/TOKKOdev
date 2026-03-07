import { describe, expect, it } from 'vitest';

import { createRequestGate } from '../request-gate';

describe('createRequestGate', () => {
    it('marks only the newest token as latest', () => {
        const gate = createRequestGate();

        const first = gate.next();
        expect(gate.isLatest(first)).toBe(true);

        const second = gate.next();
        expect(gate.isLatest(first)).toBe(false);
        expect(gate.isLatest(second)).toBe(true);
    });

    it('does not share state across gate instances', () => {
        const gateA = createRequestGate();
        const gateB = createRequestGate();

        const tokenA = gateA.next();
        const tokenB = gateB.next();

        gateA.next();

        expect(gateA.isLatest(tokenA)).toBe(false);
        expect(gateB.isLatest(tokenB)).toBe(true);
    });
});

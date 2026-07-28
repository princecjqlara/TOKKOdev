const PHILIPPINES_UTC_OFFSET_HOURS = 8;
const PHILIPPINES_UTC_OFFSET_MS = PHILIPPINES_UTC_OFFSET_HOURS * 60 * 60 * 1000;

export type PhilippinesDateParts = {
    year: number;
    month: number;
    day: number;
};

export function getPhilippinesHour(date: Date): number {
    return new Date(date.getTime() + PHILIPPINES_UTC_OFFSET_MS).getUTCHours();
}

export function getPhilippinesDayOfWeek(date: Date): number {
    return new Date(date.getTime() + PHILIPPINES_UTC_OFFSET_MS).getUTCDay();
}

export function getPhilippinesDateParts(date = new Date()): PhilippinesDateParts {
    const phDate = new Date(date.getTime() + PHILIPPINES_UTC_OFFSET_MS);

    return {
        year: phDate.getUTCFullYear(),
        month: phDate.getUTCMonth(),
        day: phDate.getUTCDate()
    };
}

export function getTomorrowPhilippinesDateParts(now = new Date()): PhilippinesDateParts {
    const dateParts = getPhilippinesDateParts(now);
    const tomorrow = new Date(Date.UTC(dateParts.year, dateParts.month, dateParts.day + 1));

    return {
        year: tomorrow.getUTCFullYear(),
        month: tomorrow.getUTCMonth(),
        day: tomorrow.getUTCDate()
    };
}

export function getPhilippinesDatePartsFromDateString(value: string): PhilippinesDateParts | null {
    const match = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!match) return null;

    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);

    if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
        return null;
    }

    if (month < 1 || month > 12 || day < 1 || day > 31) {
        return null;
    }

    return {
        year,
        month: month - 1,
        day
    };
}

export function getPhilippinesScheduledAtIso(hour: number, dateParts: PhilippinesDateParts): string {
    return new Date(
        Date.UTC(
            dateParts.year,
            dateParts.month,
            dateParts.day,
            hour - PHILIPPINES_UTC_OFFSET_HOURS,
            0,
            0,
            0
        )
    ).toISOString();
}

export function getNextPhilippinesScheduledAtIso(hour: number, now = new Date()): string {
    const todayParts = getPhilippinesDateParts(now);
    let scheduledAt = getPhilippinesScheduledAtIso(hour, todayParts);

    if (new Date(scheduledAt).getTime() <= now.getTime()) {
        scheduledAt = getPhilippinesScheduledAtIso(hour, {
            ...todayParts,
            day: todayParts.day + 1
        });
    }

    return scheduledAt;
}

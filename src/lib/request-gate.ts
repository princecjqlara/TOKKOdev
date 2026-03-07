export type RequestToken = number;

export type RequestGate = {
    next: () => RequestToken;
    isLatest: (token: RequestToken) => boolean;
};

export function createRequestGate(): RequestGate {
    let latestToken = 0;

    return {
        next() {
            latestToken += 1;
            return latestToken;
        },
        isLatest(token: RequestToken) {
            return token === latestToken;
        }
    };
}

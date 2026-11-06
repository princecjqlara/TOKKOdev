export function emailSignInMessage(error: string | null | undefined): string {
    if (error === 'AccountRateLimited') return 'Too many sign-in attempts. Wait 15 minutes before trying again.';
    if (error === 'AccountServiceUnavailable') return 'Sign-in is temporarily unavailable. Please retry shortly.';
    return 'Unable to sign in. Check your email and password and make sure your account is activated.';
}

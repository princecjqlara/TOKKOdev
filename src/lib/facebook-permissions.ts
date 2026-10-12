export const FACEBOOK_PERMISSION_LIST = [
    'email',
    'public_profile',
    'pages_show_list',
    'pages_read_engagement',
    'pages_manage_metadata',
    'pages_read_user_content',
    'pages_manage_posts',
    'pages_manage_engagement',
    'pages_messaging',
    'pages_utility_messaging',
    'business_management'
];

export const FACEBOOK_PERMISSION_SCOPE = FACEBOOK_PERMISSION_LIST.join(',');

// Requested only from Ads Guard, so Page-only logins keep their existing scopes.
export const FACEBOOK_ADS_PERMISSION_SCOPE = `${FACEBOOK_PERMISSION_SCOPE},ads_read`;

export const FACEBOOK_REAUTH_MESSAGE =
    'Facebook could not list pages with the current login token. Refresh permissions, continue with the Facebook account that admins the page, and approve all requested Page permissions.';

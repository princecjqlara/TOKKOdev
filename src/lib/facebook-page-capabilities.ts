export function hasFacebookManagementTask(page: { tasks?: string[] }): boolean {
    // New Pages Experience can return the PROFILE_PLUS task names instead.
    return Array.isArray(page.tasks) && page.tasks.some(task =>
        ['MANAGE', 'PROFILE_PLUS_MANAGE', 'PROFILE_PLUS_FULL_CONTROL'].includes(task));
}

export function hasFacebookMessagingTask(page: { tasks?: string[] }): boolean {
    return hasFacebookManagementTask(page) || (Array.isArray(page.tasks) && page.tasks.some(task =>
        ['MESSAGING', 'PROFILE_PLUS_MESSAGING', 'PAGES_MESSAGING'].includes(task)));
}

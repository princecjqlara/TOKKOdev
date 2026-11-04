import { getPageTemplates } from './facebook';
import { followUpStepError, followUpTemplateError, getFollowUpTemplates, type FollowUpStep } from './follow-up-delivery';

export class FollowUpValidationError extends Error {}

export async function validateFollowUpConfiguration(db: { from: (table: string) => any }, pageId: string, steps: FollowUpStep[]) {
    const stepError = followUpStepError(steps);
    if (stepError) throw new FollowUpValidationError(stepError);
    if (!steps.some(step => step.template_name)) return;
    const { data: page, error } = await db.from('pages').select('fb_page_id,access_token').eq('id', pageId).single();
    if (error) throw error;
    if (!page?.access_token) throw new FollowUpValidationError('Reconnect this Page to choose an approved template.');
    const templates = getFollowUpTemplates(await getPageTemplates(page.fb_page_id, page.access_token));
    for (let index = 0; index < steps.length; index++) {
        if (!steps[index].template_name) continue;
        const message = followUpTemplateError(steps[index], templates);
        if (message) throw new FollowUpValidationError(`Step ${index + 1}: ${message}`);
    }
}

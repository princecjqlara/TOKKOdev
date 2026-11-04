import { getManualReplyMessagingType, HUMAN_AGENT_REPLY_WINDOW_MS } from './human-agent-window';
import { getUtilityTemplateParameterValidationError } from './send-errors';

export const MAX_FOLLOW_UP_DELAY_MINUTES = 365 * 24 * 60;
export type FollowUpStep = {
    message_text: string;
    delay_minutes: number;
    media_type?: 'image' | 'video' | null;
    media_url?: string | null;
    template_name?: string | null;
    template_language?: string;
    template_parameters?: string[];
    use_template?: boolean;
};
export type FollowUpTemplate = {
    name: string;
    language: string;
    body: string;
    parameterCount: number;
    mediaType: 'image' | 'video' | null;
};

/** Delays are relative to the previous step, so window checks must add them. */
export function followUpNeedsTemplate(steps: FollowUpStep[], index: number): boolean {
    if (steps[index]?.use_template) return true;
    const minutes = steps.slice(0, index + 1).reduce((sum, step) => sum + Math.max(0, step.delay_minutes || 0), 0);
    return minutes * 60000 >= HUMAN_AGENT_REPLY_WINDOW_MS - 60000;
}

export function getFollowUpMessagingType(lastInboundAt: string | null | undefined, now: Date): 'RESPONSE' | 'HUMAN_AGENT' | 'UTILITY' {
    return getManualReplyMessagingType(lastInboundAt, now) || 'UTILITY';
}

/** Only expose approved templates whose parameters this composer can supply. */
export function getFollowUpTemplates(rows: unknown[]): FollowUpTemplate[] {
    return rows.flatMap(row => {
        if (!row || typeof row !== 'object') return [];
        const item = row as Record<string, any>;
        if (!['APPROVED', 'ACTIVE'].includes(String(item.status).toUpperCase()) ||
            String(item.category).toUpperCase() !== 'UTILITY' || typeof item.name !== 'string') return [];
        const components: Array<Record<string, any>> = Array.isArray(item.components) ? item.components : [];
        const body = components.find(component => String(component.type).toUpperCase() === 'BODY')?.text;
        if (typeof body !== 'string' || /\{\{\s*[^\d\s}]/.test(body)) return [];
        const parameters = [...new Set([...body.matchAll(/\{\{\s*(\d+)\s*\}\}/g)].map(match => Number(match[1])))].sort((a, b) => a - b);
        if (parameters.some((value, index) => value !== index + 1)) return [];
        const header = components.find(component => String(component.type).toUpperCase() === 'HEADER');
        const format = String(header?.format || '').toUpperCase();
        if (header && !['TEXT', 'IMAGE', 'VIDEO'].includes(format)) return [];
        if (header && format === 'TEXT' && /\{\{/.test(header.text || '')) return [];
        const buttons = components.find(component => String(component.type).toUpperCase() === 'BUTTONS')?.buttons;
        if (Array.isArray(buttons) && buttons.some(button => /\{\{/.test(button.url || '') || button.type === 'COPY_CODE')) return [];
        const language = typeof item.language === 'string' ? item.language : item.language?.code;
        if (!language) return [];
        return [{ name: item.name, language: language.replace('-', '_'), body, parameterCount: parameters.length,
            mediaType: format === 'IMAGE' ? 'image' as const : format === 'VIDEO' ? 'video' as const : null }];
    });
}

export function followUpStepError(steps: FollowUpStep[]): string | null {
    if (!steps.length) return 'Add at least one follow-up step.';
    for (let index = 0; index < steps.length; index++) {
        const step = steps[index];
        if (!step.message_text.trim() && !step.media_url?.trim() && !step.template_name) return `Step ${index + 1}: add a message, media, or template.`;
        if (followUpNeedsTemplate(steps, index) && !step.template_name) {
            return `Step ${index + 1}: choose an approved template${step.use_template ? ' for this step' : ' for delivery at or beyond the seven-day window'}.`;
        }
    }
    return null;
}

export function followUpTemplateError(step: FollowUpStep, templates: FollowUpTemplate[]): string | null {
    if (!step.template_name) return 'Choose an approved template.';
    const selected = templates.find(template => template.name === step.template_name &&
        template.language === (step.template_language || 'en_US').replace('-', '_'));
    if (!selected) return 'The selected template is not approved or available on this Page. Choose another template.';
    const values = step.template_parameters || [];
    if (values.length !== selected.parameterCount || values.some(value => !value.trim())) {
        return `Fill all ${selected.parameterCount} template parameter${selected.parameterCount === 1 ? '' : 's'}.`;
    }
    const invalid = values.map(getUtilityTemplateParameterValidationError).find(Boolean);
    if (invalid) return invalid;
    if (selected.mediaType && (step.media_type !== selected.mediaType || !step.media_url?.trim())) {
        return `This template requires ${selected.mediaType === 'image' ? 'an image' : 'a video'} attachment.`;
    }
    if (!selected.mediaType && step.media_url?.trim()) return 'Choose a template with a matching media header to include this attachment outside seven days.';
    return null;
}

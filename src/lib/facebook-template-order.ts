export const TEMPLATE_TONES = ['casual', 'friendly', 'neutral', 'formal'] as const;
export type TemplateTone = typeof TEMPLATE_TONES[number];

type SortableTemplate = {
    name: string;
    bodyText?: string;
    components?: Array<{ type: string; text?: string }>;
};

export function getTemplateMessage(template: SortableTemplate): string {
    return (template.bodyText ?? template.components?.find(component => component.type === 'BODY')?.text ?? '').trim();
}

export function isRetiredTemplate(template: SortableTemplate): boolean {
    return /^short_(casual|friendly|neutral|formal)_(?!chat_)/.test(template.name) ||
        /\b(update|notice|notification|alert|status)\b/i.test(getTemplateMessage(template));
}

/** The internal name remains the option value; users choose the actual wording. */
export function getTemplateOptionLabel(template: SortableTemplate & { language?: string }): string {
    const message = getTemplateMessage(template).replace(/\s+/g, ' ');
    return `${message || 'Message preview unavailable'} (${template.language || 'en_US'})`;
}

export function getTemplateTone(template: SortableTemplate): TemplateTone {
    const explicit = /^short_(casual|friendly|neutral|formal)_/.exec(template.name);
    if (explicit) return explicit[1] as TemplateTone;
    const text = template.bodyText ?? template.components?.find(c => c.type === 'BODY')?.text ?? '';
    if (template.name.startsWith('casual_') || /\b(hey|heads[ -]up|casual|good news)\b/i.test(text)) return 'casual';
    if (/\b(kindly|important|notice|notification|for your (review|information)|please review)\b/i.test(text)) return 'formal';
    if (/^(hi|hello)\b|friendly|quick reminder|have a great day/i.test(text) || template.name.startsWith('friendly_')) return 'friendly';
    return 'neutral';
}

/** Casual to formal, then shortest first; names break ties consistently. */
export function compareTemplates(a: SortableTemplate, b: SortableTemplate): number {
    const toneDifference = TEMPLATE_TONES.indexOf(getTemplateTone(a)) - TEMPLATE_TONES.indexOf(getTemplateTone(b));
    const body = (t: SortableTemplate) => t.bodyText ?? t.components?.find(c => c.type === 'BODY')?.text ?? '';
    return toneDifference || body(a).length - body(b).length || a.name.localeCompare(b.name);
}

/** Keep automatic page setup bounded as the full reviewed catalog grows. */
export function selectTemplateStarterSet<T extends SortableTemplate>(templates: readonly T[]): T[] {
    const sorted = [...templates].sort(compareTemplates);
    return TEMPLATE_TONES.flatMap(tone => sorted.filter(template => getTemplateTone(template) === tone).slice(0, 6));
}

import { normalizeContactName } from './contact-names';

export interface ContactRecord {
    id: string;
    psid: string;
    page_id: string;
    name: string | null;
    last_interaction_at: string | null;
}

/**
 * Replaces placeholders in a template with contact information.
 * Supports both {placeholder} and {{placeholder}} styles, case-insensitive.
 */
export function replaceTemplateVariables(template: string, contact: ContactRecord): string {
    let message = template;

    const name = normalizeContactName(contact.name) || 'there';
    const nameParts = name.split(' ');
    const firstName = nameParts[0] || 'there';
    const lastName = nameParts.length > 1 ? nameParts.slice(1).join(' ') : '';

    // IMPORTANT: Process double curly braces BEFORE single curly braces
    // to prevent {name} from matching the inner part of {{name}}
    message = message.replace(/\{\{first_name\}\}/gi, firstName);
    message = message.replace(/\{\{firstname\}\}/gi, firstName);
    message = message.replace(/\{\{\s*first[\s_-]*name\s*\}\}/gi, firstName);
    message = message.replace(/\{\{last_name\}\}/gi, lastName);
    message = message.replace(/\{\{lastname\}\}/gi, lastName);
    message = message.replace(/\{\{\s*last[\s_-]*name\s*\}\}/gi, lastName);
    message = message.replace(/\{\{name\}\}/gi, name);
    message = message.replace(/\{\{\s*name\s*\}\}/gi, name);

    message = message.replace(/\{first_name\}/gi, firstName);
    message = message.replace(/\{firstname\}/gi, firstName);
    message = message.replace(/\{\s*first[\s_-]*name\s*\}/gi, firstName);
    message = message.replace(/\{last_name\}/gi, lastName);
    message = message.replace(/\{lastname\}/gi, lastName);
    message = message.replace(/\{\s*last[\s_-]*name\s*\}/gi, lastName);
    message = message.replace(/\{name\}/gi, name);
    message = message.replace(/\{\s*name\s*\}/gi, name);

    return message;
}

/**
 * Replaces placeholders in a multi-part message (separated by |||).
 */
export function replaceTemplateVariablesForParts(
    messageWithSeparator: string,
    contact: ContactRecord
): string {
    const parts = messageWithSeparator.split('|||');
    const personalizedParts = parts.map(part => replaceTemplateVariables(part, contact));
    return personalizedParts.join('|||');
}

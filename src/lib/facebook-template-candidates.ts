import type { TemplateDefinition } from './facebook-templates';
import { compareTemplates, TEMPLATE_TONES, type TemplateTone } from './facebook-template-order';

export type TemplateCandidate = TemplateDefinition & { tone: TemplateTone; topic: string };

const GREETINGS: Record<TemplateTone, string[]> = {
    casual: ['Hey!', 'Hey there!', 'Hi!', 'Hi there!', 'Hey again!', 'Hi again!'],
    friendly: ['Hello!', 'Hello there!', 'Hello again!', 'Hi, hope you are well.', 'Hope you are well.', 'Glad to hear from you.'],
    neutral: ['', 'From our team.', 'From us.', 'A message for you.', 'Here you are.', 'Here you go.'],
    formal: ['Good day.', 'Greetings.', 'Dear customer,', 'Dear client,', 'Dear valued client,', 'Hello, good day.']
};

const LEAD_INS: Record<TemplateTone, string[]> = {
    casual: ['', 'Here you go:', 'Here it is:', 'This is for you:', 'Sending this over:', 'Thought you should know:', 'Wanted to let you know:', 'Just letting you know:', 'Here is the info:', 'Sharing this with you:', 'Here is what we have:', 'Here is what you asked for:'],
    friendly: ['', 'Here you are:', 'Here are the details:', 'Sharing this with you:', 'We wanted to let you know:', 'Just letting you know:', 'Here is what you asked for:', 'Sending this your way:', 'A quick note for you:', 'We have this for you:', 'Here is the information:', 'We thought you should know:'],
    neutral: ['', 'Please see:', 'Here are the details:', 'For your reference:', 'Here is the information:', 'As requested:', 'Please see below:', 'For your records:', 'Here is what we have:', 'Sharing the details:', 'Here is your message:', 'Here is what you requested:'],
    formal: ['', 'Please see:', 'Kindly see:', 'For your review:', 'Please take note:', 'Kindly take note:', 'Please see the details:', 'For your reference:', 'Please consider:', 'Please review:', 'Kindly review:', 'We would like to share:']
};

const ENDINGS: Record<TemplateTone, string[]> = {
    casual: ['', 'Need help?', 'Any questions?', 'Let us know.', 'Thanks!', 'Talk soon.', 'Reply if needed.', 'Keep us posted.', 'Got questions?', 'We are here to help.'],
    friendly: ['', 'Thank you!', 'Happy to help.', 'Reply for help.', 'Let us know if needed.', 'Thanks for your time.', 'Have a good day.', 'We are happy to help.', 'Feel free to reply.', 'Thanks for checking.'],
    neutral: ['', 'Thank you.', 'Reply with questions.', 'Reply for assistance.', 'Details above.', 'Keep this for reference.', 'Contact us if needed.', 'Reply to this message.', 'Let us know if unclear.', 'Please check the details.'],
    formal: ['', 'Thank you for your time.', 'Please review.', 'Kindly review.', 'Please retain for reference.', 'Reply for clarification.', 'Please check these details.', 'Contact us for assistance.', 'Please reply if needed.', 'Your response is welcome.']
};

const BODY_EXAMPLE = 'Your appointment is confirmed for Friday at 10 AM';

/** Review candidates only. Never include these in automatic page setup. */
export function buildTemplateCandidates(): TemplateCandidate[] {
    const candidates: TemplateCandidate[] = [];
    const seenBodies = new Set<string>();
    for (const tone of TEMPLATE_TONES) {
        GREETINGS[tone].forEach((greeting, greetingIndex) => {
            LEAD_INS[tone].forEach((leadIn, leadIndex) => {
                ENDINGS[tone].forEach((ending, endingIndex) => {
                    const text = [greeting, leadIn, '{{1}}.', ending].filter(Boolean).join(' ');
                    if (text.length > 100 || seenBodies.has(text)) return;
                    seenBodies.add(text);
                    candidates.push({
                        name: `short_${tone}_chat_g${greetingIndex + 1}_l${leadIndex + 1}_e${endingIndex + 1}_v2`,
                        category: 'UTILITY',
                        paramCount: 1,
                        tone,
                        topic: 'conversation',
                        components: [{ type: 'BODY', text, example: { body_text: [[BODY_EXAMPLE]] } }]
                    });
                });
            });
        });
    }
    return candidates.sort(compareTemplates);
}

export const TEMPLATE_CANDIDATES = buildTemplateCandidates();

/** Submission payload excludes local catalog metadata. */
export function getCandidatePayload(candidate: TemplateCandidate) {
    return {
        name: candidate.name,
        category: candidate.category,
        language: 'en_US',
        components: candidate.components
    };
}

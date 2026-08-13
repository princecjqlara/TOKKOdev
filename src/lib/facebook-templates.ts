import type { UtilityTemplate, TemplateComponent } from './facebook';

// Pre-defined utility templates for sending messages outside the 7-day window.
// Mix of 1-param and 2-param templates with varied message structures.
// {{1}} = main message body
// {{2}} = additional context / signature (on 2-param templates)
//
// The campaign-send logic determines which params to fill based on the template's
// paramCount property.

export type TemplateDefinition = Omit<UtilityTemplate, 'language'> & {
    paramCount: 1 | 2;
};

export type TemplateMediaType = 'image' | 'video';

export const MEDIA_TEMPLATE_SUFFIX = '_media_v1';
export const VIDEO_MEDIA_TEMPLATE_SUFFIX = '_video_v1';
export const DEFAULT_MEDIA_TEMPLATE_SAMPLE_URL =
    'https://placehold.co/1200x800/png?text=Message+Update';
export const DEFAULT_VIDEO_TEMPLATE_SAMPLE_URL =
    'https://www.w3schools.com/html/mov_bbb.mp4';

const MEDIA_TEMPLATE_SUFFIXES: Record<TemplateMediaType, string> = {
    image: MEDIA_TEMPLATE_SUFFIX,
    video: VIDEO_MEDIA_TEMPLATE_SUFFIX
};

const MEDIA_TEMPLATE_NAME_PATTERN = /_(media|video)_v(\d+)$/;

export function isMediaTemplateName(templateName: string | null | undefined): boolean {
    return typeof templateName === 'string' && MEDIA_TEMPLATE_NAME_PATTERN.test(templateName);
}

export function getBaseTemplateName(templateName: string): string {
    return templateName.replace(MEDIA_TEMPLATE_NAME_PATTERN, '');
}

export function getTemplateMediaTypeFromName(templateName: string | null | undefined): TemplateMediaType | null {
    if (typeof templateName !== 'string') return null;
    const match = templateName.match(MEDIA_TEMPLATE_NAME_PATTERN);
    if (!match) return null;
    return match[1] === 'video' ? 'video' : 'image';
}

export function getMediaTemplateName(
    templateName: string,
    mediaType: TemplateMediaType = 'image',
    version: number = 1
): string {
    if (getTemplateMediaTypeFromName(templateName) === mediaType) {
        return templateName;
    }

    const baseName = getBaseTemplateName(templateName);
    const normalizedVersion = Math.max(1, Math.floor(version));
    const suffix = normalizedVersion === 1
        ? MEDIA_TEMPLATE_SUFFIXES[mediaType]
        : `_${mediaType === 'video' ? 'video' : 'media'}_v${normalizedVersion}`;
    return `${baseName}${suffix}`;
}

export function buildMediaTemplateVariant(
    template: TemplateDefinition,
    sampleMediaHandle: string = DEFAULT_MEDIA_TEMPLATE_SAMPLE_URL,
    mediaType: TemplateMediaType = 'image'
): TemplateDefinition {
    const withoutExistingHeader = template.components.filter((component) => component.type !== 'HEADER');
    const headerFormat = mediaType.toUpperCase() as 'IMAGE' | 'VIDEO';

    return {
        ...template,
        name: getMediaTemplateName(template.name, mediaType),
        components: [
            {
                type: 'HEADER',
                format: headerFormat,
                example: {
                    header_handle: [sampleMediaHandle]
                }
            },
            ...withoutExistingHeader
        ]
    };
}

export const UTILITY_TEMPLATES: TemplateDefinition[] = [
    // ===========================================================
    //  1-PARAM TEMPLATES — {{1}} at different positions
    // ===========================================================

    // --- {{1}} in the middle ---
    {
        name: 'acct_service_update_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: 'Important update regarding your account: {{1}}. If you have any questions, please reply to this message.',
            example: { body_text: [['Your service plan has been upgraded to Premium effective immediately']] }
        }]
    },
    {
        name: 'acct_info_notice_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: 'Notice: {{1}}. This message was sent to keep you informed about your account activity.',
            example: { body_text: [['A new device was used to access your account on March 15 2026']] }
        }]
    },
    {
        name: 'order_notification_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: 'Order notification: {{1}}. Track your order status in your account at any time.',
            example: { body_text: [['Your package has been shipped via express delivery and the tracking number is PH1234567890']] }
        }]
    },
    {
        name: 'payment_notice_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: 'Payment notification: {{1}}. View your complete billing history in your account.',
            example: { body_text: [['Your payment of PHP 5000 has been received and a receipt has been sent to your email']] }
        }]
    },
    {
        name: 'booking_update_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: 'Booking update: {{1}}. If you need to make changes, please reply to this message or contact us.',
            example: { body_text: [['Your consultation scheduled for March 20 has been confirmed with our design specialist']] }
        }]
    },
    {
        name: 'support_response_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: 'Update on your support request: {{1}}. Reply to this message if you need further assistance.',
            example: { body_text: [['Our technical team has resolved the issue you reported and your account should now be working normally']] }
        }]
    },

    // --- {{1}} at the start ---
    {
        name: 'general_alert_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: '{{1}}. This is an automated notification from our system. Reply STOP to opt out.',
            example: { body_text: [['Your weekly account summary is ready and shows 3 new transactions this week']] }
        }]
    },
    {
        name: 'general_alert_v2',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: '{{1}}. Thank you for being a valued customer. For assistance, reply to this message.',
            example: { body_text: [['Your account preferences have been updated based on your recent request']] }
        }]
    },

    // --- {{1}} at the end ---
    {
        name: 'acct_reminder_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: 'Friendly reminder from our team: {{1}}.',
            example: { body_text: [['Your scheduled appointment is tomorrow at 2 PM and our team is ready to assist you']] }
        }]
    },
    {
        name: 'general_msg_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: 'Message from our team: {{1}}.',
            example: { body_text: [['Your recent inquiry has been forwarded to the appropriate department for review']] }
        }]
    },
    {
        name: 'general_notice_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: 'Important notice: {{1}}. Please review this information at your earliest convenience.',
            example: { body_text: [['Our terms of service have been updated effective April 1st 2026']] }
        }]
    },

    // --- "Hi" / greeting prefix ---
    {
        name: 'acct_followup_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: 'Hello! We have an update for you. {{1}}. Thank you for being a valued customer.',
            example: { body_text: [['Your request has been processed and the changes are now active on your account']] }
        }]
    },
    {
        name: 'general_msg_v2',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: 'Hi! {{1}}. If you have questions, feel free to reach out to us anytime.',
            example: { body_text: [['We have updated our store hours and we are now open until 9 PM on weekdays']] }
        }]
    },
    {
        name: 'general_msg_v3',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: 'Good day! Here is an update for you: {{1}}. Thank you for choosing our services.',
            example: { body_text: [['New service packages are now available and you can view them in your account dashboard']] }
        }]
    },

    // --- Approved short reminder/note templates ---
    {
        name: 'quick_note_let_know_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: 'Hi! Just letting you know {{1}}',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'quick_take_note_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: 'Hello! Please take note {{1}}',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'quick_reminder_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: 'Hi! Here\'s a quick reminder {{1}}',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'quick_heads_up_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: 'Hi! This is a quick heads up {{1}}',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },

    // --- User-tested approved templates ---
    {
        name: 'try_have_a_great_day_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: '{{1}} Have a great day!',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try_thanks_for_your_time_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: '{{1}} Thanks for your time.',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try_hey_body_hope_this_helps_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: 'Hey! {{1}} Hope this helps.',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try_a_quick_message_for_you_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: 'A quick message for you: {{1}}',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try_hi_please_see_the_message_below_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: 'Hi! Please see the message below: {{1}}',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try_kindly_see_this_message_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: 'Kindly see this message: {{1}}',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try_please_review_when_available_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: 'Please review when available: {{1}}',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try_please_take_a_moment_to_review_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: 'Please take a moment to review: {{1}}',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try_this_is_for_your_review_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: 'This is for your review: {{1}}',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try_hi_were_sending_this_over_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: 'Hi! We\'re sending this over {{1}}',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try_hi_kindly_see_below_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: 'Hi! Kindly see below {{1}}',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try_hello_kindly_check_below_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: 'Hello! Kindly check below {{1}}',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try_hi_please_take_note_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: 'Hi! Please take note {{1}}',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try_hello_heres_a_note_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: 'Hello! Here\'s a note {{1}}',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try_a_message_from_our_side_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: 'A message from our side: {{1}}',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try_please_see_the_details_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: 'Please see the details: {{1}}',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try_here_are_the_details_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: 'Here are the details: {{1}}',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try_kindly_check_the_details_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: 'Kindly check the details: {{1}}',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try_please_review_the_details_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: 'Please review the details: {{1}}',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try_please_keep_this_in_mind_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: 'Please keep this in mind: {{1}}',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try_kindly_keep_this_in_mind_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: 'Kindly keep this in mind: {{1}}',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try_hi_please_check_when_you_can_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: 'Hi! Please check when you can {{1}}',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try_hello_please_review_when_you_can_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: 'Hello! Please review when you can {{1}}',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try_hi_kindly_review_this_message_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: 'Hi! Kindly review this message {{1}}',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try_hello_heres_something_to_note_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: 'Hello! Here\'s something to note {{1}}',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try_please_be_guided_by_this_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: 'Please be guided by this: {{1}}',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try_this_is_sent_for_your_guidance_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: 'This is sent for your guidance: {{1}}',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try_please_refer_to_this_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: 'Please refer to this: {{1}}',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try_for_your_quick_reference_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: 'For your quick reference: {{1}}',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try_hello_kindly_read_this_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: 'Hello! Kindly read this {{1}}',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try_heres_the_note_for_today_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: 'Here\'s the note for today: {{1}}',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try_sending_this_note_here_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: 'Sending this note here: {{1}}',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try_please_read_this_carefully_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: 'Please read this carefully: {{1}}',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try2_a_message_for_you_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: 'A message for you {{1}}',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try2_please_review_this_note_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: 'Please review this note {{1}}',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try2_kindly_read_this_message_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: 'Kindly read this message {{1}}',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try2_kindly_take_a_moment_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: 'Kindly take a moment {{1}}',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try2_this_is_for_your_attention_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: 'This is for your attention {{1}}',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try2_please_keep_this_noted_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: 'Please keep this noted {{1}}',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try2_kindly_keep_this_noted_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: 'Kindly keep this noted {{1}}',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try2_hi_kindly_review_this_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: 'Hi, kindly review this {{1}}',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try2_hi_please_see_this_note_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: 'Hi, please see this note {{1}}',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try2_hello_please_review_this_note_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: 'Hello, please review this note {{1}}',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try2_hey_were_sending_this_over_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: 'Hey, we\'re sending this over {{1}}',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try2_hey_please_review_this_note_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: 'Hey, please review this note {{1}}',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try2_hey_please_keep_this_in_mind_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: 'Hey, please keep this in mind {{1}}',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try2_please_see_this_when_convenient_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: 'Please see this when convenient {{1}}',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try2_please_review_when_you_have_time_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: 'Please review when you have time {{1}}',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try2_kindly_review_when_you_have_time_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: 'Kindly review when you have time {{1}}',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try2_please_read_when_available_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: 'Please read when available {{1}}',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try2_kindly_read_when_available_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: 'Kindly read when available {{1}}',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try2_please_check_when_available_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: 'Please check when available {{1}}',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try2_kindly_see_this_when_available_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: 'Kindly see this when available {{1}}',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try2_were_sending_this_for_your_review_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: 'We\'re sending this for your review {{1}}',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try2_were_sending_this_for_your_guidance_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: 'We\'re sending this for your guidance {{1}}',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try2_were_sharing_this_for_your_reference_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: 'We\'re sharing this for your reference {{1}}',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try2_were_sending_this_as_a_note_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: 'We\'re sending this as a note {{1}}',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try2_were_sharing_this_as_a_reminder_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: 'We\'re sharing this as a reminder {{1}}',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try2_were_sending_this_for_checking_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: 'We\'re sending this for checking {{1}}',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try2_this_is_shared_for_your_review_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: 'This is shared for your review {{1}}',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try2_this_is_shared_for_your_checking_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: 'This is shared for your checking {{1}}',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try2_this_is_sent_for_your_attention_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: 'This is sent for your attention {{1}}',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try2_this_is_sent_for_your_checking_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: 'This is sent for your checking {{1}}',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try2_this_is_sent_to_keep_you_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: 'This is sent to keep you informed {{1}}',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try2_this_is_something_to_review_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: 'This is something to review {{1}}',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try2_this_is_something_to_check_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: 'This is something to check {{1}}',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try2_please_use_this_as_reference_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: 'Please use this as reference {{1}}',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try2_kindly_use_this_as_reference_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: 'Kindly use this as reference {{1}}',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try2_please_check_the_message_here_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: 'Please check the message here {{1}}',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try2_kindly_check_the_message_here_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: 'Kindly check the message here {{1}}',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try2_please_review_the_note_here_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: 'Please review the note here {{1}}',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try2_kindly_review_the_note_here_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: 'Kindly review the note here {{1}}',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try2_please_read_the_message_here_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: 'Please read the message here {{1}}',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try2_a_simple_note_from_us_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: 'A simple note from us {{1}}',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try2_a_helpful_note_for_you_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: 'A helpful note for you {{1}}',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try2_a_quick_message_from_us_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: 'A quick message from us {{1}}',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try2_a_small_reminder_for_you_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: 'A small reminder for you {{1}}',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try2_a_simple_reminder_from_us_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: 'A simple reminder from us {{1}}',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try2_a_short_reminder_for_you_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: 'A short reminder for you {{1}}',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try2_your_note_from_us_is_here_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: 'Your note from us is here {{1}}',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try2_your_reminder_from_us_is_here_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: 'Your reminder from us is here {{1}}',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try2_your_information_is_here_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: 'Your information is here {{1}}',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try2_your_details_are_here_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: 'Your details are here {{1}}',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try2_your_reference_is_here_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: 'Your reference is here {{1}}',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try2_your_message_is_ready_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: 'Your message is ready {{1}}',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try2_your_note_is_ready_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: 'Your note is ready {{1}}',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try2_your_reminder_is_ready_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: 'Your reminder is ready {{1}}',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try2_your_details_are_ready_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: 'Your details are ready {{1}}',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try2_sending_this_so_youre_informed_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: 'Sending this so you\'re informed {{1}}',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try2_please_take_a_look_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: '{{1}} please take a look',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try2_please_keep_this_noted_v2',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: '{{1}} please keep this noted',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try2_kindly_keep_this_noted_v2',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: '{{1}} kindly keep this noted',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try2_please_use_this_as_reference_v2',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: '{{1}} please use this as reference',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try2_this_is_worth_noting_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: '{{1}} this is worth noting',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try2_here_for_your_reference_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: '{{1}} here for your reference',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try2_here_for_your_awareness_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: '{{1}} here for your awareness',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try2_please_see_the_details_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: '{{1}} please see the details',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try2_please_check_the_details_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: '{{1}} please check the details',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try2_kindly_check_the_details_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: '{{1}} kindly check the details',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try2_please_review_the_details_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: '{{1}} please review the details',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try2_please_check_the_note_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: '{{1}} please check the note',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try2_were_sending_this_to_you_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: '{{1}} we\'re sending this to you',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try2_were_sharing_this_for_clarity_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: '{{1}} we\'re sharing this for clarity',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try2_were_sending_this_for_review_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: '{{1}} we\'re sending this for review',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try2_were_sharing_this_for_checking_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: '{{1}} we\'re sharing this for checking',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try2_please_reply_if_needed_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: '{{1}} please reply if needed',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try2_kindly_reply_if_needed_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: '{{1}} kindly reply if needed',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try2_let_us_know_if_needed_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: '{{1}} let us know if needed',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try2_were_available_if_needed_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: '{{1}} we\'re available if needed',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try2_well_be_glad_to_help_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: '{{1}} we\'ll be glad to help',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try2_please_look_into_this_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: '{{1}} please look into this',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try2_kindly_look_into_this_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: '{{1}} kindly look into this',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try2_please_take_a_moment_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: '{{1}} please take a moment',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try2_sending_this_for_your_records_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: '{{1}} sending this for your records',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try2_sharing_this_for_your_records_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: '{{1}} sharing this for your records',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try2_please_keep_this_for_reference_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: '{{1}} please keep this for reference',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try2_kindly_keep_this_for_reference_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: '{{1}} kindly keep this for reference',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try2_please_save_this_for_reference_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: '{{1}} please save this for reference',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try2_kindly_save_this_for_reference_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: '{{1}} kindly save this for reference',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try2_please_check_the_message_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: '{{1}} please check the message',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try2_kindly_check_the_message_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: '{{1}} kindly check the message',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try2_this_is_shared_with_you_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: '{{1}} this is shared with you',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try2_this_is_sent_to_you_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: '{{1}} this is sent to you',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try2_this_is_sent_for_review_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: '{{1}} this is sent for review',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try2_this_is_shared_for_checking_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: '{{1}} this is shared for checking',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try2_this_is_sent_for_checking_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: '{{1}} this is sent for checking',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try2_this_is_shared_for_reference_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: '{{1}} this is shared for reference',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try2_this_is_sent_for_reference_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: '{{1}} this is sent for reference',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try2_this_is_shared_for_clarity_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: '{{1}} this is shared for clarity',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try2_this_is_sent_for_clarity_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: '{{1}} this is sent for clarity',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try2_please_be_guided_accordingly_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: '{{1}} please be guided accordingly',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try2_kindly_be_guided_accordingly_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: '{{1}} kindly be guided accordingly',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },

    // --- Parallel page-tested approved templates ---
    {
        name: 'try3_thank_you_for_your_time_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: '{{1}} thank you for your time',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try3_hope_this_is_clear_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: '{{1}} hope this is clear',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try3_we_hope_this_helps_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: '{{1}} we hope this helps',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try3_please_check_whenever_ready_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: '{{1}} please check whenever ready',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try3_kindly_check_whenever_ready_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: '{{1}} kindly check whenever ready',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try3_please_review_whenever_ready_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: '{{1}} please review whenever ready',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try3_kindly_review_whenever_ready_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: '{{1}} kindly review whenever ready',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try3_please_read_whenever_ready_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: '{{1}} please read whenever ready',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try3_kindly_view_when_ready_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: '{{1}} kindly view when ready',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try3_sharing_this_for_convenience_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: '{{1}} sharing this for convenience',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try3_sending_this_for_convenience_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: '{{1}} sending this for convenience',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try3_shared_for_easier_reference_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: '{{1}} shared for easier reference',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try3_sent_for_easier_reference_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: '{{1}} sent for easier reference',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try3_sending_this_to_assist_you_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: '{{1}} sending this to assist you',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try3_sent_to_guide_you_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: '{{1}} sent to guide you',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try3_sent_to_keep_things_clear_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: '{{1}} sent to keep things clear',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try3_please_confirm_once_seen_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: '{{1}} please confirm once seen',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try3_kindly_confirm_once_seen_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: '{{1}} kindly confirm once seen',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try3_please_acknowledge_once_checked_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: '{{1}} please acknowledge once checked',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try3_kindly_acknowledge_once_checked_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: '{{1}} kindly acknowledge once checked',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try3_please_let_us_know_once_reviewed_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: '{{1}} please let us know once reviewed',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try3_kindly_let_us_know_once_reviewed_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: '{{1}} kindly let us know once reviewed',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try3_were_happy_to_assist_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: '{{1}} we\'re happy to assist',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try3_help_is_available_anytime_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: '{{1}} help is available anytime',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try3_support_is_available_if_needed_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: '{{1}} support is available if needed',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try3_kindly_save_this_message_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: '{{1}} kindly save this message',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try3_please_keep_this_message_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: '{{1}} please keep this message',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try3_kindly_keep_this_message_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: '{{1}} kindly keep this message',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try3_please_remember_this_note_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: '{{1}} please remember this note',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try3_kindly_remember_this_note_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: '{{1}} kindly remember this note',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try3_kindly_check_this_carefully_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: '{{1}} kindly check this carefully',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try3_this_is_for_your_records_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: '{{1}} this is for your records',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try3_this_is_for_easy_reference_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: '{{1}} this is for easy reference',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try3_this_is_for_your_convenience_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: '{{1}} this is for your convenience',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try3_this_is_for_your_guidance_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: '{{1}} this is for your guidance',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try3_this_is_for_your_checking_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: '{{1}} this is for your checking',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try3_this_is_for_your_reference_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: '{{1}} this is for your reference',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try3_this_is_for_your_information_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: '{{1}} this is for your information',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try3_this_is_for_your_next_step_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: '{{1}} this is for your next step',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try3_kindly_check_if_this_applies_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: '{{1}} kindly check if this applies',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try3_please_check_if_needed_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: '{{1}} please check if needed',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try3_kindly_check_if_needed_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: '{{1}} kindly check if needed',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try3_please_review_if_needed_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: '{{1}} please review if needed',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try3_kindly_review_if_needed_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: '{{1}} kindly review if needed',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try3_keeping_this_here_for_you_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: '{{1}} keeping this here for you',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try3_sending_this_for_easier_tracking_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: '{{1}} sending this for easier tracking',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try3_sharing_this_for_easier_tracking_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: '{{1}} sharing this for easier tracking',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try3_keeping_this_easy_to_find_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: '{{1}} keeping this easy to find',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try3_making_sure_you_have_this_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: '{{1}} making sure you have this',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try3_please_check_the_update_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: '{{1}} please check the update',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try3_kindly_check_the_update_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: '{{1}} kindly check the update',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try3_please_review_the_update_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: '{{1}} please review the update',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try3_kindly_review_the_update_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: '{{1}} kindly review the update',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try3_please_note_the_update_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: '{{1}} please note the update',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try3_kindly_note_the_update_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: '{{1}} kindly note the update',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try3_kindly_see_the_update_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: '{{1}} kindly see the update',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM']] }
        }]
    },
    {
        name: 'try3_you_may_use_context_as_reference_v1',
        category: 'UTILITY',
        paramCount: 2,
        components: [{
            type: 'BODY',
            text: '{{1}} you may use {{2}} as reference',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM', 'the updated schedule']] }
        }]
    },
    {
        name: 'try3_heres_context_for_your_next_step_v1',
        category: 'UTILITY',
        paramCount: 2,
        components: [{
            type: 'BODY',
            text: '{{1}} here\'s {{2}} for your next step',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM', 'the updated schedule']] }
        }]
    },
    {
        name: 'try3_you_can_move_forward_with_context_v1',
        category: 'UTILITY',
        paramCount: 2,
        components: [{
            type: 'BODY',
            text: '{{1}} you can move forward with {{2}}',
            example: { body_text: [['your appointment has been confirmed for tomorrow at 2 PM', 'the updated schedule']] }
        }]
    },

    {
        name: 'friendly_msg_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: 'Hey! Just wanted to let you know — {{1}}. Feel free to reply if you have any questions!',
            example: { body_text: [['we just restocked the items you were looking at and they are available again']] }
        }]
    },
    {
        name: 'friendly_msg_v2',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: 'Hi there! {{1}}. Let us know if there is anything else we can help with.',
            example: { body_text: [['Your order has been prepared and is ready for pickup at our main branch']] }
        }]
    },
    {
        name: 'friendly_msg_v3',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: 'Just a quick heads up: {{1}}. Thanks!',
            example: { body_text: [['we will be having a short maintenance window tonight from 10 PM to 11 PM']] }
        }]
    },
    {
        name: 'friendly_msg_v4',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: 'Hi! Quick update for you — {{1}}. Hope this helps!',
            example: { body_text: [['your refund has been processed and should appear in your account within 3 to 5 business days']] }
        }]
    },
    {
        name: 'friendly_msg_v5',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: '{{1}} — just keeping you in the loop!',
            example: { body_text: [['We have finished setting up your new account and everything is good to go']] }
        }]
    },
    {
        name: 'friendly_msg_v6',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: 'Hey, just thought you should know: {{1}}.',
            example: { body_text: [['the item you reserved has arrived and is waiting for you at the store']] }
        }]
    },
    {
        name: 'casual_update_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: 'Good news! {{1}}. Reach out if you need anything else.',
            example: { body_text: [['Your replacement part has arrived early and we can schedule the repair at your convenience']] }
        }]
    },
    {
        name: 'casual_update_v3',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: 'Just checking in! {{1}}. Let us know how it goes.',
            example: { body_text: [['Your new setup should be working now and we wanted to make sure everything is running smoothly']] }
        }]
    },
    {
        name: 'casual_update_v4',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: 'Quick reminder — {{1}}. Talk soon!',
            example: { body_text: [['your appointment with our team is tomorrow at 3 PM so just reply if you need to reschedule']] }
        }]
    },
    {
        name: 'simple_msg_v4',
        category: 'UTILITY',
        paramCount: 1,
        components: [{
            type: 'BODY',
            text: 'Just a note: {{1}}. Have a great day!',
            example: { body_text: [['we have applied the discount to your next order as discussed']] }
        }]
    },

    // ===========================================================
    //  2-PARAM TEMPLATES — {{1}} and {{2}} with varied layouts
    // ===========================================================

    // --- {{1}} body + {{2}} closing ---
    {
        name: 'acct_update_2p_v1',
        category: 'UTILITY',
        paramCount: 2,
        components: [{
            type: 'BODY',
            text: 'Account update: {{1}}. {{2}}.',
            example: { body_text: [['Your membership has been renewed for another year', 'Thank you for your continued support']] }
        }]
    },
    {
        name: 'service_notice_2p_v1',
        category: 'UTILITY',
        paramCount: 2,
        components: [{
            type: 'BODY',
            text: 'Service notice: {{1}}. For reference: {{2}}.',
            example: { body_text: [['Your service appointment has been rescheduled', 'New date is April 5 at 10 AM']] }
        }]
    },
    {
        name: 'order_update_2p_v1',
        category: 'UTILITY',
        paramCount: 2,
        components: [{
            type: 'BODY',
            text: 'Order update: {{1}}. Details: {{2}}. Contact us if you need help.',
            example: { body_text: [['Your order is on its way', 'Estimated delivery is March 25 between 9 AM and 5 PM']] }
        }]
    },

    // --- greeting + {{1}} + {{2}} sign-off ---
    {
        name: 'acct_greeting_2p_v1',
        category: 'UTILITY',
        paramCount: 2,
        components: [{
            type: 'BODY',
            text: 'Hello! {{1}}. {{2}}. If you have questions, please reply to this message.',
            example: { body_text: [['We wanted to let you know about an important change to your account settings', 'Your preferences have been saved successfully']] }
        }]
    },
    {
        name: 'acct_greeting_2p_v2',
        category: 'UTILITY',
        paramCount: 2,
        components: [{
            type: 'BODY',
            text: 'Hi there! {{1}} - {{2}}. Thank you for your attention.',
            example: { body_text: [['Your billing cycle has been updated', 'Next payment is due on April 15']] }
        }]
    },

    // --- static prefix + {{1}} + static middle + {{2}} ---
    {
        name: 'acct_detail_2p_v1',
        category: 'UTILITY',
        paramCount: 2,
        components: [{
            type: 'BODY',
            text: 'Important: {{1}}. Additional information: {{2}}.',
            example: { body_text: [['Your account security settings have been updated', 'Two-factor authentication is now enabled']] }
        }]
    },
    {
        name: 'acct_detail_2p_v2',
        category: 'UTILITY',
        paramCount: 2,
        components: [{
            type: 'BODY',
            text: 'Notification: {{1}}. Note: {{2}}. Reply for assistance.',
            example: { body_text: [['Your subscription plan will change on your next billing date', 'You can cancel anytime before the renewal date']] }
        }]
    },
    {
        name: 'delivery_info_2p_v1',
        category: 'UTILITY',
        paramCount: 2,
        components: [{
            type: 'BODY',
            text: 'Delivery update: {{1}}. Tracking info: {{2}}.',
            example: { body_text: [['Your package has been dispatched from our warehouse', 'Tracking number PH9876543210 via LBC Express']] }
        }]
    },

    // --- {{1}} then {{2}} with minimal static ---
    {
        name: 'quick_update_2p_v1',
        category: 'UTILITY',
        paramCount: 2,
        components: [{
            type: 'BODY',
            text: '{{1}} - {{2}}',
            example: { body_text: [['Your appointment has been confirmed for April 3 at 2 PM', 'Please arrive 10 minutes early and bring your ID']] }
        }]
    },
    {
        name: 'quick_notice_2p_v1',
        category: 'UTILITY',
        paramCount: 2,
        components: [{
            type: 'BODY',
            text: '{{1}}. {{2}}.',
            example: { body_text: [['Your recent transaction has been processed successfully', 'A confirmation email has been sent to your registered address']] }
        }]
    },

    // ===========================================================
    //  TEMPLATES WITH BUTTONS (1-param and 2-param)
    // ===========================================================

    // --- 1-param with single URL button ---
    {
        name: 'acct_update_btn_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [
            {
                type: 'BODY',
                text: 'Account update: {{1}}. Tap below for more details.',
                example: { body_text: [['Your membership renewal options are now available for the upcoming period']] }
            },
            {
                type: 'BUTTONS',
                buttons: [{ type: 'URL', text: 'View Details', url: 'https://example.com/account' }]
            }
        ]
    },
    {
        name: 'order_track_btn_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [
            {
                type: 'BODY',
                text: 'Your order has been updated. {{1}}. Track your order below.',
                example: { body_text: [['Your package is currently in transit and will arrive within 2 business days']] }
            },
            {
                type: 'BUTTONS',
                buttons: [{ type: 'URL', text: 'Track Order', url: 'https://example.com/track' }]
            }
        ]
    },

    // --- 1-param with postback buttons ---
    {
        name: 'booking_confirm_btn_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [
            {
                type: 'BODY',
                text: 'Booking confirmation: {{1}}. Use the buttons below to manage your booking.',
                example: { body_text: [['Your design consultation has been scheduled for next Monday at 3 PM']] }
            },
            {
                type: 'BUTTONS',
                buttons: [
                    { type: 'POSTBACK', text: 'Confirm', payload: 'CONFIRM_BOOKING' },
                    { type: 'POSTBACK', text: 'Reschedule', payload: 'RESCHEDULE_BOOKING' }
                ]
            }
        ]
    },

    // --- 2-param with URL button ---
    {
        name: 'service_update_btn_2p_v1',
        category: 'UTILITY',
        paramCount: 2,
        components: [
            {
                type: 'BODY',
                text: 'Service update: {{1}}. Reference: {{2}}.',
                example: { body_text: [['Your support ticket has been updated with a new response', 'Ticket number SUP-20260328-001']] }
            },
            {
                type: 'BUTTONS',
                buttons: [
                    { type: 'URL', text: 'View Ticket', url: 'https://example.com/support' },
                    { type: 'POSTBACK', text: 'Mark Resolved', payload: 'TICKET_RESOLVED' }
                ]
            }
        ]
    },
    {
        name: 'promo_notice_btn_2p_v1',
        category: 'UTILITY',
        paramCount: 2,
        components: [
            {
                type: 'BODY',
                text: 'Notification for you: {{1}}. Details: {{2}}.',
                example: { body_text: [['A special offer is now available on your account', 'Valid until April 30 2026 for all Premium members']] }
            },
            {
                type: 'BUTTONS',
                buttons: [{ type: 'URL', text: 'Learn More', url: 'https://example.com/offers' }]
            }
        ]
    },
    
    // --- InstantMeeting Domain Buttons ---
    {
        name: 'instant_meeting_btn_v1',
        category: 'UTILITY',
        paramCount: 1,
        components: [
            {
                type: 'BODY',
                text: 'Important update: {{1}}',
                example: { body_text: [['The host has joined the meeting room']] }
            },
            {
                type: 'BUTTONS',
                buttons: [{ type: 'URL', text: 'Join Meeting', url: 'https://instantmeeting.vercel.app/' }]
            }
        ]
    },
    {
        name: 'instant_meeting_btn_v2',
        category: 'UTILITY',
        paramCount: 1,
        components: [
            {
                type: 'BODY',
                text: 'Update on your request: {{1}}',
                example: { body_text: [['Your meeting has been scheduled']] }
            },
            {
                type: 'BUTTONS',
                buttons: [{ type: 'URL', text: 'View Details', url: 'https://instantmeeting.vercel.app/' }]
            }
        ]
    },
    {
        name: 'instant_meeting_btn_v3',
        category: 'UTILITY',
        paramCount: 1,
        components: [
            {
                type: 'BODY',
                text: 'Notification: {{1}}',
                example: { body_text: [['You have a new meeting request pending']] }
            },
            {
                type: 'BUTTONS',
                buttons: [{ type: 'URL', text: 'Book Now', url: 'https://instantmeeting.vercel.app/' }]
            }
        ]
    }
];

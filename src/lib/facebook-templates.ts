import { UtilityTemplate, TemplateComponent } from './facebook';

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

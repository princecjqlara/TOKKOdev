// Database types
export interface User {
  id: string;
  email: string;
  name: string | null;
  image: string | null;
  facebook_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface Business {
  id: string;
  name: string;
  created_by: string;
  created_at: string;
}

export interface BusinessUser {
  id: string;
  business_id: string;
  user_id: string;
  role: string;
  created_at: string;
}

export interface Page {
  id: string;
  fb_page_id: string;
  name: string;
  access_token: string;
  business_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface UserPage {
  id: string;
  user_id: string;
  page_id: string;
  created_at: string;
}

export interface Contact {
  id: string;
  page_id: string;
  psid: string;
  name: string | null;
  profile_pic: string | null;
  last_interaction_at: string | null;
  first_interaction_at: string | null;
  created_at: string;
  updated_at: string;
  tags?: Tag[];
  best_contact_hour: number | null;
  best_contact_hours?: { hour: number; count: number }[];
  best_contact_confidence: 'high' | 'medium' | 'low' | 'inferred' | 'none';
  interaction_count?: number;
}

export interface Tag {
  id: string;
  name: string;
  color: string;
  owner_type: 'user' | 'page' | 'business';
  owner_id: string;
  page_id: string | null;
  is_shared?: boolean;
  shared_with_user_ids?: string[];
  tagged_by_user_id?: string | null;
  tagged_by_name?: string | null;
  created_at: string;
}

export interface ContactTag {
  id: string;
  contact_id: string;
  tag_id: string;
  created_at: string;
}

export interface Campaign {
  id: string;
  page_id: string;
  name: string;
  message_text: string | null;
  status: 'draft' | 'scheduled' | 'sending' | 'completed' | 'cancelled';
  scheduled_at: string | null;
  total_recipients: number;
  sent_count: number;
  failed_count: number;
  created_by: string;
  created_at: string;
  updated_at: string;
  use_best_time: boolean;
  scheduled_date: string | null;
  audience_mode?: 'specific' | 'dynamic';
  audience_start_date?: string | null;
  audience_include_tag_ids?: string[];
  audience_exclude_tag_ids?: string[];
  is_loop?: boolean;
  ai_prompt?: string | null;
  loop_status?: 'active' | 'paused' | 'stopped';
  use_ai_message?: boolean;
  template_name?: string | null;
  template_language?: string | null;
  recurrence?: 'none' | 'daily';
  recurrence_end_at?: string | null;
  last_error?: string | null;
  background_delivery_enabled?: boolean;
}

export interface CampaignRecipient {
  id: string;
  campaign_id: string;
  contact_id: string;
  status: 'pending' | 'sent' | 'failed';
  sent_at: string | null;
  error_message: string | null;
  scheduled_at?: string | null;
  next_scheduled_at?: string | null;
}

export interface WorkflowAutomation {
  id: string;
  page_id: string;
  name: string;
  enabled: boolean;
  trigger_type: 'contact_reply' | 'follow_up';
  message_text: string;
  stop_keywords?: string[];
  steps: Array<{
    message_text: string;
    delay_minutes: number;
    media_type?: 'image' | 'video' | null;
    media_url?: string | null;
  }>;
  reply_action: 'stop' | 'reset' | 'continue';
  page_stop_code: string | null;
  cooldown_minutes: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface WorkflowAutomationState {
  id: string;
  automation_id: string;
  contact_id: string;
  status: 'active' | 'stopped' | 'completed';
  current_step_index: number;
  next_step_at: string | null;
  stopped_at: string | null;
  stopped_reason: 'contact_reply' | 'page_stop_code' | 'outside_human_agent_window' | null;
  last_triggered_at: string | null;
  last_sent_at: string | null;
  last_contact_reply_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

// API Response types
export interface PaginatedResponse<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  archived?: boolean;
  archivedAt?: string | null;
}

export interface ApiError {
  error: string;
  message: string;
}

// Facebook API types
export interface FacebookPage {
  id: string;
  name: string;
  access_token: string;
  category?: string;
  picture?: {
    data: {
      url: string;
    };
  };
}

export interface FacebookConversation {
  id: string;
  participants: {
    data: Array<{
      id: string;
      name: string;
    }>;
  };
  updated_time: string;
}

export interface FacebookMessage {
  id: string;
  message: string;
  from: {
    id: string;
    name: string;
  };
  created_time: string;
}

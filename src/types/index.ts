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
  created_at: string;
  updated_at: string;
  tags?: Tag[];
}

export interface Tag {
  id: string;
  name: string;
  color: string;
  owner_type: 'user' | 'page' | 'business';
  owner_id: string;
  page_id: string | null;
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
  status: 'draft' | 'sending' | 'completed' | 'cancelled';
  total_recipients: number;
  sent_count: number;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface CampaignRecipient {
  id: string;
  campaign_id: string;
  contact_id: string;
  status: 'pending' | 'sent' | 'failed';
  sent_at: string | null;
  error_message: string | null;
}

// API Response types
export interface PaginatedResponse<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
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

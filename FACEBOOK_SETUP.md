# Facebook App Setup Guide

Follow these steps to set up your Facebook app integration.

## Step 1: Create a Facebook App

1. Go to [Facebook Developers](https://developers.facebook.com/)
2. Click **"My Apps"** → **"Create App"**
3. Select **"Business"** as the app type
4. Fill in:
   - **App Name**: Your app name (e.g., "Tokko Beta")
   - **App Contact Email**: Your email
   - Click **"Create App"**

## Step 2: Get Your App Credentials

1. In your app dashboard, go to **Settings** → **Basic**
2. Note down:
   - **App ID** (this is your `FACEBOOK_CLIENT_ID`)
   - **App Secret** (click "Show" to reveal - this is both `FACEBOOK_CLIENT_SECRET` and `FACEBOOK_APP_SECRET`)

## Step 3: Add Facebook Login Product

1. In the left sidebar, click **"+ Add Product"**
2. Find **"Facebook Login"** and click **"Set Up"**
3. Select **"Web"** platform
4. In **Settings** → **Facebook Login** → **Settings**:
   - **Valid OAuth Redirect URIs**: Add these URLs:
     ```
     https://mae-squarish-sid.ngrok-free.dev/api/auth/callback/facebook
     http://localhost:3000/api/auth/callback/facebook
     ```
   - **Deauthorize Callback URL**: 
     ```
     https://mae-squarish-sid.ngrok-free.dev/api/auth/callback/facebook
     ```
   - **Data Deletion Request URL** (optional):
     ```
     https://mae-squarish-sid.ngrok-free.dev/api/auth/callback/facebook
     ```

## Step 4: Request Required Permissions

1. Go to **App Review** → **Permissions and Features**
2. Request these permissions (if not already approved):
   - `email` ✅ (usually auto-approved)
   - `public_profile` ✅ (usually auto-approved)
   - `pages_show_list` - To list user's Facebook pages
   - `pages_messaging` - To send/receive messages
   - `pages_read_engagement` - To read page engagement
   - `pages_manage_metadata` - To manage page metadata

**Note**: Some permissions may require App Review for production use. For development, you can test with your own Facebook account.

## Step 5: Set Up Webhooks

1. Go to **Webhooks** in the left sidebar
2. Click **"Add Webhook"**
3. Fill in:
   - **Callback URL**: 
     ```
     https://mae-squarish-sid.ngrok-free.dev/api/facebook/webhook
     ```
   - **Verify Token**: 
     - First, get your verify token by visiting:
       ```
       https://mae-squarish-sid.ngrok-free.dev/api/facebook/webhook?show_token=true
       ```
     - Copy the `verify_token` value from the response
   - **Subscription Fields**: Select:
     - ✅ `messages`
     - ✅ `messaging_postbacks`
     - ✅ `messaging_optins`
     - ✅ `messaging_referrals`
     - ✅ `messaging_handovers`
     - ✅ `messaging_policy_enforcement`
     - ✅ `messaging_account_linking`
     - ✅ `messaging_deliveries`
     - ✅ `messaging_reads`
     - ✅ `messaging_reactions`
     - ✅ `messaging_app_roles`
     - ✅ `messaging_echoes`
     - ✅ `messaging_standby`
     - ✅ `messaging_payments`
     - ✅ `messaging_checkout_updates`
     - ✅ `messaging_pre_checkouts`
     - ✅ `messaging_game_plays`
     - ✅ `messaging_ice_breakers`
     - ✅ `messaging_seen`
     - ✅ `messaging_thread_control`
4. Click **"Verify and Save"**
5. Facebook will send a GET request to verify your webhook - it should succeed automatically!

## Step 6: Subscribe Pages to Webhook

1. Go to **Webhooks** → **Page** tab
2. Click **"Subscribe"** next to your page
3. Select the same subscription fields as above
4. Click **"Subscribe"**

## Step 7: Update Your .env File

Add your Facebook credentials to your `.env` file:

```env
FACEBOOK_CLIENT_ID=your-app-id-here
FACEBOOK_CLIENT_SECRET=your-app-secret-here
FACEBOOK_APP_SECRET=your-app-secret-here
```

**Note**: `FACEBOOK_CLIENT_SECRET` and `FACEBOOK_APP_SECRET` are the same value (your App Secret).

## Step 8: Test the Integration

1. Make sure your Next.js app is running: `npm run dev`
2. Make sure ngrok is running and pointing to port 3000
3. Visit your app: `https://mae-squarish-sid.ngrok-free.dev`
4. Click "Sign in with Facebook"
5. Grant permissions
6. You should be redirected back and logged in!

## Troubleshooting

### Webhook Verification Fails
- Make sure your ngrok URL is accessible
- Check that the verify token matches (visit `/api/facebook/webhook?show_token=true`)
- Ensure your app is running and ngrok is active

### OAuth Redirect Error
- Verify the redirect URL in Facebook matches exactly: `https://mae-squarish-sid.ngrok-free.dev/api/auth/callback/facebook`
- Make sure there are no trailing slashes

### Permissions Not Granted
- Some permissions require App Review for production
- For development, test with your own Facebook account first
- Make sure you're requesting the correct scopes

## Important Notes

- **ngrok URL changes**: If you restart ngrok, you'll get a new URL. Update Facebook settings accordingly.
- **Production**: For production, replace ngrok URLs with your actual domain
- **App Review**: Some permissions require Facebook App Review before they work for all users







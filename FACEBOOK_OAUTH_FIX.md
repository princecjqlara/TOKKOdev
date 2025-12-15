# Facebook OAuth Redirect Fix

## The Problem
Facebook is rejecting the OAuth request because the redirect URI doesn't match.

## The Solution

### Step 1: Go to Facebook Login Settings
**Direct Link:** https://developers.facebook.com/apps/1350694239880908/fb-login/settings/

### Step 2: Find "Valid OAuth Redirect URIs"
Scroll down to find this section.

### Step 3: Add This Exact URL
Copy and paste this EXACTLY (no changes):

```
https://mae-squarish-sid.ngrok-free.dev/api/auth/callback/facebook
```

### Step 4: Save
Click "Save Changes" button.

### Step 5: Wait
Wait 2-3 minutes for Facebook to update their settings.

### Step 6: Test
Refresh your app and try the Facebook sign-in button again.

## Common Mistakes to Avoid

❌ **WRONG:**
- `http://mae-squarish-sid.ngrok-free.dev/api/auth/callback/facebook` (missing 's' in https)
- `https://mae-squarish-sid.ngrok-free.dev/api/auth/callback/facebook/` (trailing slash)
- `https://mae-squarish-sid.ngrok-free.dev/callback/facebook` (missing /api/auth)
- `https://mae-squarish-sid.ngrok-free.dev/api/auth/callback` (missing /facebook)

✅ **CORRECT:**
- `https://mae-squarish-sid.ngrok-free.dev/api/auth/callback/facebook`

## Also Check

1. **App Mode:** Should be "Development" (not "Live")
   - Go to: https://developers.facebook.com/apps/1350694239880908/settings/basic/
   - Check the top of the page

2. **App Domains:** Should include:
   - `mae-squarish-sid.ngrok-free.dev`
   - `localhost`

## Still Not Working?

1. Check browser console (F12) for errors
2. Check server terminal for NextAuth errors
3. Verify Facebook app is in Development Mode
4. Make sure you waited 2-3 minutes after saving







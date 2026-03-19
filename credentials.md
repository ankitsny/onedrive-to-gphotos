# Getting Your Credentials

This guide walks you through getting the 3 values needed in your `.env` file:

```
ONEDRIVE_CLIENT_ID=
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
```

---

## Part 1 — OneDrive Client ID (Microsoft Azure)

### Step 1 — Register a new app
1. Go to [portal.azure.com](https://portal.azure.com)
2. In the top search bar, type **"App registrations"** and click it
3. Click **"+ New registration"**
4. Fill in:
   - **Name**: `OneDrive Migration`
   - **Supported account types**: `Personal Microsoft accounts only`
   - Leave Redirect URI blank
5. Click **Register**

### Step 2 — Copy your Client ID
- After registering, you land on the app overview page
- Copy the **"Application (client) ID"** (looks like `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`)
- This is your `ONEDRIVE_CLIENT_ID` ✅

### Step 3 — Enable public client flow
1. In the left sidebar, click **Authentication (Preview)**
2. Click the **Settings** tab
3. Under **"Allow public client flows"** — toggle it to **Enabled**
4. Click **Save**

> This allows the tool to open a browser for sign-in using the device code flow.

### Step 4 — Add API permissions
1. In the left sidebar, click **"API permissions"**
2. Click **"+ Add a permission"**
3. Click **"Microsoft Graph"** → **"Delegated permissions"**
4. Search and check **`Files.Read`**
5. Search and check **`offline_access`**
6. Click **"Add permissions"**

You should now see 3 permissions: `Files.Read`, `offline_access`, `User.Read` (User.Read is added automatically — that's fine).

---

## Part 2 — Google Photos Client ID & Secret

### Step 1 — Enable the Photos Library API
1. Go to [console.cloud.google.com](https://console.cloud.google.com)
2. Select or create a project (top bar)
3. Go to **APIs & Services → Library**
4. Search **"Photos Library API"** → click it → click **Enable**

### Step 2 — Configure OAuth consent screen
1. In the left sidebar, go to **Google Auth Platform → Overview**
2. Click **"Get started"** and fill in:
   - **App name**: `Photos Migration`
   - **User support email**: your Gmail
   - **Developer contact email**: your Gmail
3. Click **Save and Continue** through all steps

### Step 3 — Add the required scope
1. In the left sidebar, click **Data Access**
2. Click **"Add or remove scopes"**
3. Search for `photoslibrary` and check **`photoslibrary.appendonly`**
4. Click **Update** → **Save and Continue**

> This scope is required — without it uploads will fail with a 403 error.

### Step 4 — Add yourself as a test user
1. In the left sidebar, click **Audience**
2. Scroll down to **"Test users"**
3. Click **"+ Add users"** → enter your Gmail → click **Add**

> Keep the app in **Testing** mode — no need to publish. Testing mode with yourself as a test user is all you need.

### Step 5 — Create OAuth credentials
1. In the left sidebar, click **Clients**
2. Click **"Create OAuth client"**
3. Fill in:
   - **Application type**: `Desktop app`
   - **Name**: `Photos Migration`
4. Click **Create**

### Step 6 — Copy your Client ID and Secret
- A popup appears with your credentials
- Copy **Client ID** → this is your `GOOGLE_CLIENT_ID`
- Copy **Client Secret** → this is your `GOOGLE_CLIENT_SECRET`

> Click **"Download JSON"** to save a backup copy.

---

## Your final .env file

Create a file called `.env` in the project folder:

```
# From Azure → App registrations → your app → Overview
ONEDRIVE_CLIENT_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx

# From Google Cloud → Clients → your OAuth client
GOOGLE_CLIENT_ID=xxxxxxxxxxxx.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-xxxxxxxxxxxxxxxxxx

# Optional: customize the Google Photos album name (default: "From OneDrive")
# GOOGLE_ALBUM_NAME=From OneDrive
```

---

## What happens on first run

```bash
npm start
```

**OneDrive authentication:**
- Browser opens automatically to `microsoft.com/link`
- A code is printed in the terminal — type it into the browser page
- Sign in with your Microsoft account → click Allow
- Terminal continues automatically

**Google Photos authentication:**
- Browser opens automatically to Google sign-in
- Sign in with the Gmail you added as a test user
- You'll see "✅ Authenticated! You can close this tab."
- Terminal continues and migration starts

Both tokens are cached locally — you won't need to sign in again on future runs.

---

## Re-running after interruption

The tool is safe to restart at any time. Just run `npm start` again — it will skip already-uploaded files and continue from where it left off.

If you want to start completely fresh:

```bash
rm -f .onedrive_token.json .google_token.json migration.db
npm start
```

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| 403 error on upload | Make sure `photoslibrary.appendonly` scope is added in Google Cloud → Data Access. Delete `.google_token.json` and re-run. |
| "Token expired" | Delete `.onedrive_token.json` or `.google_token.json` and re-run |
| "Access denied" on OneDrive | Check that "Allow public client flows" is Enabled in Azure → Authentication |
| "This app isn't verified" on Google | Click **"Advanced"** → **"Go to Photos Migration (unsafe)"** — expected for test mode apps |
| `no such table` error | Delete `migration.db` and re-run — the DB will be recreated with the correct schema |
| Scan finds 0 files | Check that `Files.Read` permission is granted in Azure → API permissions |
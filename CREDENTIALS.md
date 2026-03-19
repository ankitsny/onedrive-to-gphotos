# Setting Up Credentials

You need 3 values in your `.env` file:

```bash
ONEDRIVE_CLIENT_ID=        # from Microsoft Azure
GOOGLE_CLIENT_ID=          # from Google Cloud Console
GOOGLE_CLIENT_SECRET=      # from Google Cloud Console
```

---

## Part 1 — OneDrive (Microsoft Azure)

### Step 1 — Register an app

1. Go to [portal.azure.com](https://portal.azure.com) and sign in
2. Search **"App registrations"** in the top bar → click it
3. Click **"+ New registration"**
4. Fill in:
   - **Name**: `OneDrive Migration`
   - **Supported account types**: `Personal Microsoft accounts only`
   - Leave Redirect URI blank
5. Click **Register**

### Step 2 — Copy your Client ID

On the app overview page, copy **"Application (client) ID"**

```
ONEDRIVE_CLIENT_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
```

### Step 3 — Enable public client flow

1. Left sidebar → **Authentication (Preview)**
2. Click the **Settings** tab
3. Under **"Allow public client flows"** → toggle to **Enabled**
4. Click **Save**

> Without this, authentication will fail silently.

### Step 4 — Add API permissions

1. Left sidebar → **API permissions** → **"+ Add a permission"**
2. Click **Microsoft Graph** → **Delegated permissions**
3. Search and check **`Files.Read`**
4. Search and check **`offline_access`**
5. Click **Add permissions**

You should see 3 permissions: `Files.Read`, `offline_access`, `User.Read` (User.Read is added automatically — that's fine ✅)

---

## Part 2 — Google Photos (Google Cloud Console)

### Step 1 — Enable the Photos Library API

1. Go to [console.cloud.google.com](https://console.cloud.google.com)
2. Select or create a project from the top bar
3. Go to **APIs & Services → Library**
4. Search **"Photos Library API"** → click it → click **Enable**

### Step 2 — Configure OAuth consent screen

1. Left sidebar → **Google Auth Platform → Overview**
2. Click **"Get started"** and fill in:
   - **App name**: `Photos Migration`
   - **User support email**: your Gmail
   - **Developer contact email**: your Gmail
3. Click through all steps clicking **Save and Continue** (no need to add scopes here)

### Step 3 — Add the required scope

> ⚠️ **This step is easy to miss — skipping it causes a 403 error on every upload.**

1. Left sidebar → **Data Access**
2. Click **"Add or remove scopes"**
3. Search `photoslibrary` → check **`photoslibrary.appendonly`**
4. Click **Update** → **Save and Continue**

### Step 4 — Add yourself as a test user

1. Left sidebar → **Audience**
2. Scroll to **"Test users"** → click **"+ Add users"**
3. Enter your Gmail → click **Add**

> Keep the app in **Testing** mode — no need to publish. You're the only user.

### Step 5 — Create OAuth credentials

1. Left sidebar → **Clients** → **"Create OAuth client"**
2. Fill in:
   - **Application type**: `Desktop app`
   - **Name**: `Photos Migration`
3. Click **Create**

### Step 6 — Copy your credentials

A popup appears with your credentials. Copy both:

```
GOOGLE_CLIENT_ID=xxxxxxxxxxxx.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-xxxxxxxxxxxxxxxxxx
```

> Click **"Download JSON"** to save a backup.

---

## Your final .env file

```bash
# Microsoft Azure → App registrations → your app → Overview
ONEDRIVE_CLIENT_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx

# Google Cloud → Clients → your OAuth client
GOOGLE_CLIENT_ID=xxxxxxxxxxxx.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-xxxxxxxxxxxxxxxxxx

# Optional — customize album name (default: "From OneDrive")
# GOOGLE_ALBUM_NAME=From OneDrive

# Optional — skip files larger than this during testing (remove for full migration)
# MAX_FILE_SIZE_MB=100
```

---

## First Run

```bash
npm start
```

**OneDrive sign-in:**
- Browser opens automatically to `microsoft.com/link`
- A short code is printed in your terminal — type it into the browser page
- Sign in with your Microsoft account → click **Allow**
- Terminal resumes automatically

**Google Photos sign-in:**
- Browser opens automatically to Google sign-in
- Sign in with the Gmail you added as a test user
- You'll see "✅ Authenticated! You can close this tab."
- Terminal resumes and migration starts

Both tokens are cached locally — you won't need to sign in again on future runs.

> If you see **"This app isn't verified"** on Google → click **Advanced** → **"Go to Photos Migration (unsafe)"** — this is expected for apps in Testing mode.

---

## Re-running / Resuming

The tool is safe to restart at any time:

```bash
npm start          # resumes from where it left off automatically
```

To start completely fresh:

```bash
rm -f .onedrive_token.json .google_token.json migration.db
npm start
```

---

## Troubleshooting

| Problem | Fix |
|---|---|
| **403 on upload** | Add `photoslibrary.appendonly` scope in Google Cloud → Data Access (Step 3 above). Delete `.google_token.json` and re-run. |
| **"Token expired"** | Delete `.onedrive_token.json` or `.google_token.json` and re-run |
| **"Access denied" on OneDrive** | Check "Allow public client flows" is Enabled in Azure → Authentication |
| **"This app isn't verified"** | Click **Advanced** → **Go to Photos Migration (unsafe)** — expected for test mode |
| **`no such table` error** | Delete `migration.db` and re-run — DB will be recreated with correct schema |
| **Scan finds 0 files** | Check `Files.Read` permission is granted in Azure → API permissions |
| **Upload stuck / slow** | Normal for large libraries — leave running overnight, it resumes safely if interrupted |

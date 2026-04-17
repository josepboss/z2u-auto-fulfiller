# Z2U Auto Fulfiller — Backend + Chrome Extension

A two-part automation system for fulfilling Z2U orders automatically using the Lfollowers.com API.

---

## Part 1: Node.js Backend

### Prerequisites

- Node.js 18+ and pnpm
- A VPS running Ubuntu/Debian (or any Linux distro)
- PM2 installed globally (`npm install -g pm2`)

### Local Setup

```bash
# Clone the repo
git clone https://github.com/YOUR_USERNAME/YOUR_REPO.git
cd YOUR_REPO

# Install dependencies
pnpm install

# Configure environment
cp artifacts/api-server/.env.example artifacts/api-server/.env
# Edit .env and set LFOLLOWERS_API_KEY=<your key>
nano artifacts/api-server/.env

# Run locally
pnpm --filter @workspace/api-server run dev
```

The server starts on port `3000` by default. Visit `http://localhost:3000/api/admin` to access the Admin Dashboard.

### Pushing to GitHub

```bash
# Initialize git (if not already done)
git init
git add .
git commit -m "Initial commit"

# Create a repo on GitHub, then:
git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO.git
git branch -M main
git push -u origin main
```

---

## Part 2: VPS Deployment with PM2

### 1. SSH into your VPS

```bash
ssh user@your-vps-ip
```

### 2. Install Node.js and pnpm

```bash
curl -fsSL https://fnm.vercel.app/install | bash
source ~/.bashrc
fnm install 20
npm install -g pnpm pm2
```

### 3. Clone the repository

```bash
git clone https://github.com/YOUR_USERNAME/YOUR_REPO.git
cd YOUR_REPO
pnpm install
```

### 4. Configure environment variables

```bash
cp artifacts/api-server/.env.example artifacts/api-server/.env
nano artifacts/api-server/.env
```

Set:
```
LFOLLOWERS_API_KEY=your_actual_api_key_here
PORT=3000
SESSION_SECRET=a_strong_random_secret
```

### 5. Build the server

```bash
pnpm --filter @workspace/api-server run build
```

### 6. Start with PM2

```bash
pm2 start artifacts/api-server/dist/index.mjs --name z2u-backend --interpreter node
pm2 save
pm2 startup
```

Follow the PM2 startup command output to enable auto-start on reboot.

### 7. (Optional) Reverse proxy with Nginx

Install Nginx and configure a proxy to port 3000:

```nginx
server {
    listen 80;
    server_name your-domain.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
```

Use Certbot for HTTPS:

```bash
sudo certbot --nginx -d your-domain.com
```

---

## Admin Dashboard

Once the server is running, open:

```
http://your-server:3000/api/admin
```

- Add Z2U Offer Titles and map them to Lfollowers Service IDs
- Mappings are stored in `artifacts/api-server/mappings.json`

---

## Part 3: Chrome Extension

### Installation (Developer Mode)

1. Open Chrome and go to `chrome://extensions`
2. Enable **Developer Mode** (top right toggle)
3. Click **Load unpacked**
4. Select the `chrome-extension/` folder from this project

### Configuration

- Click the extension icon in Chrome's toolbar
- Enter your backend server URL (e.g., `http://your-vps-ip:3000` or `https://your-domain.com`)
- Click **Save Settings**
- The popup will show "Backend: Connected" when ready

### How It Works

1. The extension monitors `z2u.com/sellOrder/index` automatically
2. It refreshes the page every 45–90 seconds (randomized to avoid detection)
3. When a **NEW ORDER** is found:
   - It checks if the full title matches a mapping in your backend
   - Clicks **Prepare** → **Start Trading** → **Confirm** in the popup
   - Downloads the Z2U Excel template
   - Sends it to your backend `/api/process-order` endpoint
   - The backend fetches accounts from Lfollowers and fills the template
   - The filled file is uploaded back to Z2U
   - **Confirm Delivered** is clicked automatically
4. Processed order IDs are stored in `chrome.storage` to prevent duplicates

### Editing the Config

To change refresh timing or other settings, edit `chrome-extension/config.js`:

```js
const CONFIG = {
  SERVER_URL: "http://localhost:3000",  // Override via popup
  MIN_REFRESH_SECONDS: 45,
  MAX_REFRESH_SECONDS: 90,
  Z2U_ORDERS_URL: "https://z2u.com/sellOrder/index",
};
```

---

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/healthz` | Health check |
| GET | `/api/admin` | Admin dashboard UI |
| GET | `/api/admin/mappings` | Get all title→serviceId mappings |
| POST | `/api/admin/mappings` | Add/update a mapping |
| DELETE | `/api/admin/mappings/:title` | Delete a mapping |
| GET | `/api/admin/services` | Fetch Lfollowers service list |
| POST | `/api/order` | Place an order on Lfollowers |
| POST | `/api/process-order` | Process XLSX template + return filled file |

### POST /api/process-order

**Form data:**
- `file` — the Z2U Excel template (.xlsx)
- `title` — the Z2U offer title (must match a mapping)
- `quantity` — number of accounts/rows to fill
- `orderId` — (optional) Z2U order ID for naming the output file

**Response:** A filled `.xlsx` file download.

---

## Updating on VPS

```bash
cd YOUR_REPO
git pull
pnpm install
pnpm --filter @workspace/api-server run build
pm2 restart z2u-backend
```

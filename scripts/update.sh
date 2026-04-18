#!/bin/bash
# Run this on your VPS after every git pull to rebuild and restart the server
set -e

echo "Pulling latest code..."
git pull

echo "Installing dependencies..."
pnpm install --frozen-lockfile

echo "Building server..."
pnpm --filter @workspace/api-server run build

echo "Restarting PM2..."
pm2 restart z2u-backend

echo "Done. Server updated and restarted."

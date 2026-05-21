#!/bin/bash
# ============================================
# CryptoBot VPS Deploy Script
# Run this on the VPS: bash deploy.sh
# ============================================

set -e  # Exit on error

BOT_DIR="/opt/crypto-bot"
PM2_NAME="crypto-bot"

echo "🚀 Deploying CryptoBot..."

cd "$BOT_DIR"

echo "📥 Pulling latest code..."
git pull origin main

echo "📦 Installing dependencies..."
pnpm install --frozen-lockfile

echo "🔨 Building TypeScript..."
pnpm build

echo "🗄️  Syncing database schema..."
pnpm db:push

echo "♻️  Restarting PM2 process..."
pm2 restart "$PM2_NAME" || pm2 start dist/index.js --name "$PM2_NAME" --restart-delay=5000

echo "✅ Deploy complete! Logs:"
pm2 logs "$PM2_NAME" --lines 20 --nostream

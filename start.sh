#!/bin/bash
cd /workspaces/herald-portal

echo "🛑 Stopping any old server..."
pkill -f "node server.js" 2>/dev/null
sleep 1

echo "🗑️  Resetting DB (fresh seed)..."
rm -f herald.db herald.db-shm herald.db-wal

echo "🚀 Starting server in background..."
nohup npm start > server.log 2>&1 &
sleep 4

if curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/login.html | grep -q 200; then
  echo ""
  echo "✅ SERVER IS RUNNING"
  echo ""
  echo "🌐 Open in browser:"
  echo "   https://${CODESPACE_NAME}-3000.app.github.dev/login.html"
  echo "   https://${CODESPACE_NAME}-3000.app.github.dev/admin-login.html"
  echo ""
  echo "🔑 Credentials:"
  echo "   Student: STU001 / password123"
  echo "   Admin:   admin  / admin123"
else
  echo ""
  echo "❌ SERVER FAILED TO START"
  echo "─── server.log ───"
  cat server.log
fi

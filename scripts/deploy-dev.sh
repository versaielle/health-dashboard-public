#!/bin/bash
set -e

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "→ Committing changes..."
  git add -A
  git commit -m "Deploy $(date '+%Y-%m-%d %H:%M')"
fi

echo "→ Pushing development branch to remote..."
git push origin development

echo "→ Deploying to dev.your-domain.example.com..."
ssh -i ~/.ssh/id_ed25519_deploy deploy@your-server.example.com '
  cd /opt/health-dashboard-dev &&
  git fetch origin &&
  git checkout development &&
  git pull origin development &&
  cd server && npm install --omit=dev &&
  sudo systemctl restart health-dashboard-dev
'

echo "✓ Dev deployed → https://dev.your-domain.example.com"

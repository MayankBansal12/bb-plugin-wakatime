#!/usr/bin/env bash
set -euo pipefail
cd /home/echio-staging/code-projects/bb-plugin-wakatime

# real theme tokens from the bb app this plugin runs inside
cp /home/echio-staging/.bb-machines/mayank.getbb.app/npm/lib/node_modules/bb-app/app/dist/assets/index-CXWZ8ak3.css preview/bb-theme.css

# the plugin's own Tailwind pass output
npm run build >/dev/null
cp dist/app.css preview/app.css

npx esbuild preview/entry.tsx \
  --bundle --format=iife --jsx=automatic --target=es2022 \
  --tsconfig=tsconfig.json \
  --alias:@get-bb/plugin-sdk/app=./preview/sdk-mock.tsx \
  --outfile=preview/bundle.js --log-level=warning

node preview/shoot.mjs preview/shot dark
node preview/shoot.mjs preview/shot light

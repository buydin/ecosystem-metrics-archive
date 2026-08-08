# Ecosystem Metrics Archive - Rules & Goals

## Current Goals
1. Maintain a highly efficient, 18-server Load Balanced Map-Reduce architecture for scraping the Fortnite Ecosystem API.
2. Ensure the API natively fetches a full 7-day rolling window of historical data (`?from=` and `to=`).
3. Maintain 7 perfectly segmented daily databases (`metrics_YYYY-MM-DD.db`) in the GitHub Releases to track hourly/minute data.
4. Integrate safe external features (like Discord Webhooks) without exposing sensitive data to the public.

## Strict Rules for AI Assistant
1. **NEVER commit and push code to GitHub without explicitly asking the user for permission first.**
2. Protect the integrity of the 7-day historical database architecture (Do not use "Smart Skip" or anything that drops days).
3. Keep the repository public for unlimited free GitHub Action minutes, using GitHub Secrets to secure private credentials.
4. Focus on `ecosystem-metrics-archive` before switching back to the local `scrapper` UI.

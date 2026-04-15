# MovieMates-X Bot

A Node.js bot that posts high-rated movies from TMDB to X (Twitter) every 6 hours.

## Setup

1. Install dependencies: `npm install`
2. Set up environment variables in `.env` (already provided)
3. Run the bot: `npm start`

## Features

- Fetches high-rated movies (vote_average >= 7, vote_count >= 1000) from TMDB
- Posts a random movie every 6 hours
- Uses Twitter API v2 for posting tweets
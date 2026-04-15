require('dotenv').config();
const axios = require('axios');
const { TwitterApi } = require('twitter-api-v2');

const client = new TwitterApi({
  appKey: process.env.X_CONSUMER_KEY,
  appSecret: process.env.X_CONSUMER_SECRET,
  accessToken: process.env.X_ACCESS_TOKEN,
  accessSecret: process.env.X_ACCESS_TOKEN_SECRET,
});

const rwClient = client.readWrite;

async function getHighRatedMovies() {
  const url = `https://api.themoviedb.org/3/discover/movie?api_key=${process.env.TMDB_API_KEY}&sort_by=vote_average.desc&vote_count.gte=1000&vote_average.gte=7`;
  const response = await axios.get(url);
  return response.data.results;
}

async function postRandomMovie() {
  const movies = await getHighRatedMovies();
  const randomMovie = movies[Math.floor(Math.random() * movies.length)];
  const tweetText = `🎥 ${randomMovie.title} (${randomMovie.release_date.split('-')[0]})\n⭐ ${randomMovie.vote_average}/10\n${randomMovie.overview}\n#MovieBot #TMDB`;

  const tweetPayload = {};
  if (randomMovie.poster_path) {
    const posterUrl = `https://image.tmdb.org/t/p/w500${randomMovie.poster_path}`;
    const imgResponse = await axios.get(posterUrl, { responseType: 'arraybuffer' });
    const mediaId = await rwClient.v1.uploadMedia(Buffer.from(imgResponse.data), { mimeType: 'image/jpeg' });
    tweetPayload.media = { media_ids: [mediaId] };
  }

  await rwClient.v2.tweet(tweetText, tweetPayload);
  console.log('Tweet posted:', tweetText);
}

postRandomMovie().catch((err) => {
  console.error('Failed to post:', err);
  process.exit(1);
});
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

async function getCredits(movieId) {
  const url = `https://api.themoviedb.org/3/movie/${movieId}/credits?api_key=${process.env.TMDB_API_KEY}`;
  const response = await axios.get(url);
  const cast = response.data.cast.slice(0, 3);
  const directors = response.data.crew.filter((p) => p.job === 'Director');
  return { cast, directors };
}

function toHashtag(name) {
  return `#${name.replace(/[^a-zA-Z0-9]/g, '')}`;
}

async function getWatchProviders(movieId) {
  const url = `https://api.themoviedb.org/3/movie/${movieId}/watch/providers?api_key=${process.env.TMDB_API_KEY}`;
  const response = await axios.get(url);
  const region = response.data.results.TR || response.data.results.US;
  if (!region) return [];
  const providers = [
    ...(region.flatrate || []),
    ...(region.ads || []),
    ...(region.free || []),
  ];
  const seen = new Set();
  return providers.filter((p) => {
    if (seen.has(p.provider_name)) return false;
    seen.add(p.provider_name);
    return true;
  });
}

async function postRandomMovie() {
  const movies = await getHighRatedMovies();
  const randomMovie = movies[Math.floor(Math.random() * movies.length)];
  const { cast, directors } = await getCredits(randomMovie.id);
  const providers = await getWatchProviders(randomMovie.id);
  const castTags = cast.map((p) => toHashtag(p.name)).join(' ');
  const directorTags = directors.map((p) => toHashtag(p.name)).join(' ');
  const providerTags = providers.length > 0
    ? providers.map((p) => toHashtag(p.provider_name)).join(' ')
    : 'N/A';
  const tweetText = `🎥 ${randomMovie.title} (${randomMovie.release_date.split('-')[0]})\n⭐ ${randomMovie.vote_average.toFixed(1)}/10\n${randomMovie.overview}\n\n🎭 Cast\n${castTags}\n\n🎬 Director\n${directorTags}\n\n📺 Platforms\n${providerTags}\n\n#MovieMates`;

  const tweetPayload = {};
  const mediaIds = [];
  if (randomMovie.poster_path) {
    const posterUrl = `https://image.tmdb.org/t/p/w500${randomMovie.poster_path}`;
    const imgResponse = await axios.get(posterUrl, { responseType: 'arraybuffer' });
    const mediaId = await rwClient.v1.uploadMedia(Buffer.from(imgResponse.data), { mimeType: 'image/jpeg' });
    mediaIds.push(mediaId);
  }
  if (randomMovie.backdrop_path) {
    const backdropUrl = `https://image.tmdb.org/t/p/w1280${randomMovie.backdrop_path}`;
    const imgResponse = await axios.get(backdropUrl, { responseType: 'arraybuffer' });
    const mediaId = await rwClient.v1.uploadMedia(Buffer.from(imgResponse.data), { mimeType: 'image/jpeg' });
    mediaIds.push(mediaId);
  }
  if (mediaIds.length > 0) {
    tweetPayload.media = { media_ids: mediaIds };
  }

  await rwClient.v2.tweet(tweetText, tweetPayload);
  console.log('Tweet posted:', tweetText);
}

postRandomMovie().catch((err) => {
  console.error('Failed to post:', err);
  process.exit(1);
});
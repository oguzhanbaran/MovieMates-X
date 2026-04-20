require('dotenv').config();
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { TwitterApi } = require('twitter-api-v2');

const POSTED_FILE = path.join(__dirname, 'posted.json');

function getPostedMovies() {
  if (!fs.existsSync(POSTED_FILE)) return [];
  return JSON.parse(fs.readFileSync(POSTED_FILE, 'utf-8'));
}

function savePostedMovie(id, title) {
  const movies = getPostedMovies();
  movies.push({ id, title });
  fs.writeFileSync(POSTED_FILE, JSON.stringify(movies, null, 2));
}

const client = new TwitterApi({
  appKey: process.env.X_CONSUMER_KEY,
  appSecret: process.env.X_CONSUMER_SECRET,
  accessToken: process.env.X_ACCESS_TOKEN,
  accessSecret: process.env.X_ACCESS_TOKEN_SECRET,
});

const rwClient = client.readWrite;

async function getHighRatedMovies() {
  const totalPages = 5;
  let allMovies = [];

  for (let page = 1; page <= totalPages; page++) {
    const url = `https://api.themoviedb.org/3/discover/movie?api_key=${process.env.TMDB_API_KEY}&sort_by=vote_count.desc&vote_average.gte=7&page=${page}`;
    const response = await axios.get(url);
    allMovies = allMovies.concat(response.data.results);
  }

  return allMovies;
}

const GENRE_MAP = {
  28: 'Action', 12: 'Adventure', 16: 'Animation', 35: 'Comedy',
  80: 'Crime', 99: 'Documentary', 18: 'Drama', 10751: 'Family',
  14: 'Fantasy', 36: 'History', 27: 'Horror', 10402: 'Music',
  9648: 'Mystery', 10749: 'Romance', 878: 'Sci-Fi', 10770: 'TV Movie',
  53: 'Thriller', 10752: 'War', 37: 'Western',
};

async function getMovieDetails(movieId) {
  const url = `https://api.themoviedb.org/3/movie/${movieId}?api_key=${process.env.TMDB_API_KEY}`;
  const response = await axios.get(url);
  return response.data;
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
  const postedMovies = getPostedMovies();
  const postedIds = postedMovies.map((m) => m.id);
  const available = movies.filter((m) => !postedIds.includes(m.id));
  if (available.length === 0) {
    console.log('All movies have been posted already.');
    return;
  }
  const randomMovie = available[Math.floor(Math.random() * available.length)];
  const [{ cast, directors }, providers, details] = await Promise.all([
    getCredits(randomMovie.id),
    getWatchProviders(randomMovie.id),
    getMovieDetails(randomMovie.id),
  ]);
  const genres = randomMovie.genre_ids.map((id) => GENRE_MAP[id]).filter(Boolean).join(' | ');
  const hours = Math.floor(details.runtime / 60);
  const mins = details.runtime % 60;
  const runtime = `${hours}h ${mins}m`;
  const castTags = cast.map((p) => toHashtag(p.name)).join(' ');
  const directorTags = directors.map((p) => toHashtag(p.name)).join(' ');
  const providerTags = providers.length > 0
    ? providers.map((p) => toHashtag(p.provider_name)).join(' ')
    : 'N/A';
  const tweetText = `🎥 ${randomMovie.title} (${randomMovie.release_date.split('-')[0]})\n⭐ ${randomMovie.vote_average.toFixed(1)}/10\n🎞️ ${genres}\n⏱️ ${runtime}\n${randomMovie.overview}\n\n🎭 Cast\n${castTags}\n\n🎬 Director\n${directorTags}\n\n📺 Platforms\n${providerTags}\n\n#MovieMates`;

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
  savePostedMovie(randomMovie.id, randomMovie.title);
  console.log('Tweet posted:', tweetText);
}

postRandomMovie().catch((err) => {
  console.error('Failed to post:', err);
  process.exit(1);
});
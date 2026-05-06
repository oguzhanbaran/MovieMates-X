require('dotenv').config();
const axios = require('axios');
const { TwitterApi } = require('twitter-api-v2');
const Anthropic = require('@anthropic-ai/sdk');

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ALLOWED_CHAT_ID = String(process.env.TELEGRAM_CHAT_ID);
const TMDB_API_KEY = process.env.TMDB_API_KEY;

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const twitter = new TwitterApi({
  appKey: process.env.X_CONSUMER_KEY,
  appSecret: process.env.X_CONSUMER_SECRET,
  accessToken: process.env.X_ACCESS_TOKEN,
  accessSecret: process.env.X_ACCESS_TOKEN_SECRET,
});

const GENRE_MAP = {
  28: 'Action', 12: 'Adventure', 16: 'Animation', 35: 'Comedy',
  80: 'Crime', 99: 'Documentary', 18: 'Drama', 10751: 'Family',
  14: 'Fantasy', 36: 'History', 27: 'Horror', 10402: 'Music',
  9648: 'Mystery', 10749: 'Romance', 878: 'Science Fiction', 10770: 'TV Movie',
  53: 'Thriller', 10752: 'War', 37: 'Western',
};

const TG_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

const pendingPicks = new Map();
const PICK_TTL = 30 * 60 * 1000;

async function tg(method, payload) {
  const res = await axios.post(`${TG_API}/${method}`, payload);
  return res.data;
}

async function sendMessage(chatId, text) {
  return tg('sendMessage', { chat_id: chatId, text });
}

async function sendPhoto(chatId, photoUrl, caption) {
  return tg('sendPhoto', { chat_id: chatId, photo: photoUrl, caption });
}

function extractTweetId(text) {
  const m = text.match(/(?:twitter\.com|x\.com)\/[^/]+\/status\/(\d+)/);
  return m ? m[1] : null;
}

async function fetchTweet(tweetId) {
  return twitter.v2.singleTweet(tweetId, {
    expansions: ['attachments.media_keys'],
    'media.fields': ['url', 'preview_image_url', 'type'],
    'tweet.fields': ['text'],
  });
}

const EMOJI_ONLY = /^[\s\p{Emoji_Presentation}\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Emoji_Component}]+$/u;

function cleanReplyText(text) {
  return (text || '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/@\w+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchTopReplies(tweetId, n = 5) {
  try {
    const result = await twitter.v2.search(`conversation_id:${tweetId}`, {
      'tweet.fields': ['public_metrics', 'text'],
      max_results: 10,
    });
    const tweets = result.tweets || [];
    return tweets
      .filter((t) => {
        const cleaned = cleanReplyText(t.text);
        if (cleaned.length < 10) return false;
        if (EMOJI_ONLY.test(cleaned)) return false;
        if (cleaned.endsWith('?')) return false;
        return true;
      })
      .sort((a, b) => (b.public_metrics?.like_count || 0) - (a.public_metrics?.like_count || 0))
      .slice(0, n)
      .map((t) => ({
        text: cleanReplyText(t.text),
        likes: t.public_metrics?.like_count || 0,
      }));
  } catch (e) {
    console.error('Replies fetch failed:', e.message);
    return [];
  }
}

async function urlToImageBlock(url) {
  const res = await axios.get(url, { responseType: 'arraybuffer' });
  const mime = res.headers['content-type'] || 'image/jpeg';
  return {
    type: 'image',
    source: {
      type: 'base64',
      media_type: mime.split(';')[0],
      data: Buffer.from(res.data).toString('base64'),
    },
  };
}

async function identifyMovie(tweetText, mediaUrls, replies = []) {
  const content = [];
  for (const url of mediaUrls) {
    try {
      content.push(await urlToImageBlock(url));
    } catch (e) {
      console.error('Image fetch failed:', url, e.message);
    }
  }
  const repliesBlock = replies.length > 0
    ? `\n\nTop replies under the tweet, sorted by likes (the most-liked reply is usually the answer for "what movie?" tweets). IGNORE jokes, reactions, and replies that don't explicitly name a film — only use replies that mention a specific movie title:\n"""\n${replies.map((r, i) => `${i + 1}. [${r.likes} likes] ${r.text}`).join('\n')}\n"""`
    : '';
  content.push({
    type: 'text',
    text: `Identify the top 3 candidate movies that the following tweet text, replies and (if present) images could be referring to, ranked by likelihood. Return the result as a JSON array only (no markdown, no commentary), each item with: title (original English), year (number), confidence (0-100 number). Example output:
[{"title":"Prisoners","year":2013,"confidence":75},{"title":"Nightcrawler","year":2014,"confidence":15},{"title":"Zodiac","year":2007,"confidence":10}]

If you cannot identify any plausible movies, return the empty array [].

Tweet text:
"""
${tweetText}
"""${repliesBlock}`,
  });

  const msg = await anthropic.messages.create({
    model: 'claude-opus-4-7',
    max_tokens: 2200,
    thinking: { type: 'adaptive' },
    output_config: { effort: 'medium' },
    messages: [{ role: 'user', content }],
  });

  const textBlock = msg.content.find((b) => b.type === 'text');
  const raw = (textBlock?.text || '').trim();
  const jsonMatch = raw.match(/\[[\s\S]*\]/);
  if (!jsonMatch) return [];
  try {
    const arr = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((c) => c && typeof c.title === 'string' && c.title.trim())
      .slice(0, 3)
      .map((c) => ({
        title: String(c.title).trim(),
        year: c.year ? Number(c.year) : null,
        confidence: c.confidence != null ? Number(c.confidence) : null,
      }));
  } catch (e) {
    console.error('Candidate JSON parse failed:', e.message, 'raw:', raw);
    return [];
  }
}

async function searchMovie(query) {
  const m = query.match(/^(.+?)\s*\((\d{4})\)\s*$/);
  const title = m ? m[1].trim() : query;
  const year = m ? m[2] : null;
  const params = new URLSearchParams({
    api_key: TMDB_API_KEY,
    query: title,
    language: 'en-US',
  });
  if (year) params.set('year', year);
  const res = await axios.get(`https://api.themoviedb.org/3/search/movie?${params}`);
  return res.data.results[0];
}

async function getDetails(movieId) {
  const url = `https://api.themoviedb.org/3/movie/${movieId}?api_key=${TMDB_API_KEY}&language=en-US`;
  return (await axios.get(url)).data;
}

async function getCredits(movieId) {
  const url = `https://api.themoviedb.org/3/movie/${movieId}/credits?api_key=${TMDB_API_KEY}`;
  const res = await axios.get(url);
  return {
    cast: res.data.cast.slice(0, 3),
    directors: res.data.crew.filter((p) => p.job === 'Director'),
  };
}

async function getProviders(movieId) {
  const url = `https://api.themoviedb.org/3/movie/${movieId}/watch/providers?api_key=${TMDB_API_KEY}`;
  const res = await axios.get(url);
  const region = res.data.results.TR || res.data.results.US;
  if (!region) return [];
  const all = [...(region.flatrate || []), ...(region.ads || []), ...(region.free || [])];
  const seen = new Set();
  return all.filter((p) => (seen.has(p.provider_name) ? false : seen.add(p.provider_name)));
}

function toHashtag(name) {
  return `#${name.replace(/[^a-zA-Z0-9]/g, '')}`;
}

const AD_LINES = [
  'Unnamed movie scene? Just drop the link into MovieMates — it finds the movie instantly, adds it to your watchlist, and lets you manage the same list with your loved ones. Link in bio.',
  "Saw a clip and don't know the movie? Paste the link into MovieMates — instant ID, save it to your watchlist, share the list with friends. Link in bio.",
  'MovieMates names any clip from a single link, saves it to your watchlist, and lets you build shared lists with the people you love. Link in bio.',
  'That nameless movie scene on your feed? Send the link to MovieMates — it identifies the film, adds it to your list, and you can curate together with loved ones. Link in bio.',
  'Stop scrolling past unnamed clips. Drop the link into MovieMates: instant movie ID, watchlist save, shared lists with your favorite people. Link in bio.',
  'One link is all it takes — MovieMates finds the movie, saves it to your watchlist, and connects your list with the people you love. Link in bio.',
  'Found a movie clip with no title? MovieMates IDs it from the link alone, adds it to your watchlist, and lets you share the list with loved ones. Link in bio.',
  'MovieMates: paste a link, get the movie name, save it for later, and build the list together with the people you love. Link in bio.',
];

function pickAdLine() {
  return AD_LINES[Math.floor(Math.random() * AD_LINES.length)];
}

async function buildTweetText(searchResult) {
  const [{ cast, directors }, providers, details] = await Promise.all([
    getCredits(searchResult.id),
    getProviders(searchResult.id),
    getDetails(searchResult.id),
  ]);
  const genres = (searchResult.genre_ids || details.genres.map((g) => g.id))
    .map((id) => GENRE_MAP[id]).filter(Boolean).join(' | ');
  const hours = Math.floor((details.runtime || 0) / 60);
  const mins = (details.runtime || 0) % 60;
  const runtime = `${hours}h ${mins}m`;
  const overview = details.overview || searchResult.overview;
  const castTags = cast.map((p) => toHashtag(p.name)).join(' ');
  const directorTags = directors.map((p) => toHashtag(p.name)).join(' ');
  const providerTags = providers.length > 0
    ? providers.map((p) => toHashtag(p.provider_name)).join(' ')
    : 'None';
  const year = (searchResult.release_date || details.release_date || '').split('-')[0];
  const rating = (searchResult.vote_average ?? details.vote_average ?? 0).toFixed(1);
  const title = searchResult.title || details.title;
  return `${pickAdLine()}\n\n🎥 ${title} (${year})\n⭐ ${rating}/10\n🎞️ ${genres}\n⏱️ ${runtime}\n${overview}\n\n🎭 Cast\n${castTags}\n\n🎬 Director\n${directorTags}\n\n📺 Platforms\n${providerTags}\n\n#MovieMates`;
}

async function handleMessage(message) {
  const chatId = message.chat.id;
  if (String(chatId) !== ALLOWED_CHAT_ID) {
    console.log('Ignored message from unauthorized chat:', chatId);
    return;
  }
  const text = message.text || message.caption || '';
  const tweetId = extractTweetId(text);
  if (!tweetId) {
    await sendMessage(chatId, 'Send a tweet link (twitter.com or x.com).');
    return;
  }

  await sendMessage(chatId, '🔎 Analyzing tweet...');

  let tweetText = '';
  let mediaUrls = [];
  try {
    const tweet = await fetchTweet(tweetId);
    tweetText = tweet.data?.text || '';
    mediaUrls = (tweet.includes?.media || [])
      .map((m) => m.url || m.preview_image_url)
      .filter(Boolean);
  } catch (e) {
    console.error('Tweet fetch failed:', e.message);
    await sendMessage(chatId, `Failed to fetch tweet: ${e.message}`);
    return;
  }

  const replies = await fetchTopReplies(tweetId, 5);
  if (replies.length > 0) console.log(`Using ${replies.length} top replies (top likes: ${replies[0].likes})`);

  let candidates;
  try {
    candidates = await identifyMovie(tweetText, mediaUrls, replies);
  } catch (e) {
    console.error('Claude failed:', e.message);
    await sendMessage(chatId, `Movie identification failed: ${e.message}`);
    return;
  }

  if (!candidates || candidates.length === 0) {
    await sendMessage(chatId, '❌ Could not identify the movie.');
    return;
  }

  const sessionId = Math.random().toString(36).slice(2, 10);
  pendingPicks.set(sessionId, { candidates, expiresAt: Date.now() + PICK_TTL });

  const buttons = candidates.map((c, i) => [{
    text: `${c.title}${c.year ? ` (${c.year})` : ''}${c.confidence != null ? ` — %${c.confidence}` : ''}`,
    callback_data: `pick:${sessionId}:${i}`,
  }]);

  await tg('sendMessage', {
    chat_id: chatId,
    text: '🎬 Hangi film? En olası 3 aday:',
    reply_markup: { inline_keyboard: buttons },
  });
}

async function handleCallback(cq) {
  const chatId = cq.message?.chat?.id;
  if (!chatId || String(chatId) !== ALLOWED_CHAT_ID) return;
  await tg('answerCallbackQuery', { callback_query_id: cq.id }).catch(() => {});

  const m = (cq.data || '').match(/^pick:([^:]+):(\d+)$/);
  if (!m) return;
  const [, sessionId, idxStr] = m;
  const session = pendingPicks.get(sessionId);
  if (!session) {
    await sendMessage(chatId, 'Bu seçim oturumu sona erdi, linki tekrar gönder.');
    return;
  }
  const candidate = session.candidates[Number(idxStr)];
  if (!candidate) return;
  pendingPicks.delete(sessionId);

  const query = candidate.year ? `${candidate.title} (${candidate.year})` : candidate.title;
  const movie = await searchMovie(query);
  if (!movie) {
    await sendMessage(chatId, `❌ Not found on TMDB: ${query}`);
    return;
  }

  if (candidate.confidence != null) {
    await sendMessage(chatId, `🎯 Film tanıma doğruluk oranı: %${candidate.confidence}`);
  }
  const formatted = await buildTweetText(movie);
  await sendMessage(chatId, formatted);
  if (movie.poster_path) {
    await sendPhoto(chatId, `https://image.tmdb.org/t/p/w500${movie.poster_path}`);
  }
}

async function main() {
  console.log('Bot started, listening for messages...');
  let offset = 0;
  while (true) {
    try {
      const res = await axios.get(`${TG_API}/getUpdates`, {
        params: { offset, timeout: 30 },
        timeout: 35000,
      });
      for (const update of res.data.result) {
        offset = update.update_id + 1;
        if (update.callback_query) {
          handleCallback(update.callback_query).catch((e) => {
            console.error('Callback error:', e);
          });
          continue;
        }
        const message = update.message || update.channel_post;
        if (!message) continue;
        handleMessage(message).catch((e) => {
          console.error('Handler error:', e);
          sendMessage(message.chat.id, `Error: ${e.message}`).catch(() => {});
        });
      }
    } catch (e) {
      console.error('Polling error:', e.message);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

main();

require('dotenv').config();
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const axios = require('axios');
const { TwitterApi } = require('twitter-api-v2');
const Anthropic = require('@anthropic-ai/sdk');
const ffmpegPath = require('ffmpeg-static');

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
    'media.fields': ['url', 'preview_image_url', 'type', 'variants'],
    'tweet.fields': ['text'],
  });
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, args);
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve(stderr);
      else reject(new Error(`ffmpeg exit ${code}: ${stderr.slice(-400)}`));
    });
  });
}

function getVideoDuration(file) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, ['-i', file]);
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', reject);
    proc.on('close', () => {
      const m = stderr.match(/Duration: (\d+):(\d+):(\d+\.\d+)/);
      if (!m) return reject(new Error('Could not parse duration'));
      resolve(Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]));
    });
  });
}

async function extractVideoFrames(videoUrl, count = 3) {
  const res = await axios.get(videoUrl, { responseType: 'arraybuffer', timeout: 30000, maxContentLength: 80 * 1024 * 1024 });
  const tmpVideo = path.join(os.tmpdir(), `mm-${Date.now()}-${Math.random().toString(36).slice(2)}.mp4`);
  fs.writeFileSync(tmpVideo, Buffer.from(res.data));
  const frameFiles = [];
  try {
    const duration = await getVideoDuration(tmpVideo);
    const start = duration * 0.1;
    const end = duration * 0.9;
    const step = count > 1 ? (end - start) / (count - 1) : 0;
    const frames = [];
    for (let i = 0; i < count; i++) {
      const t = start + step * i;
      const tmpFrame = path.join(os.tmpdir(), `mm-frame-${Date.now()}-${i}-${Math.random().toString(36).slice(2)}.jpg`);
      frameFiles.push(tmpFrame);
      await runFfmpeg(['-y', '-ss', String(t), '-i', tmpVideo, '-vframes', '1', '-q:v', '3', tmpFrame]);
      frames.push(fs.readFileSync(tmpFrame));
    }
    return frames;
  } finally {
    for (const f of [tmpVideo, ...frameFiles]) {
      try { fs.unlinkSync(f); } catch {}
    }
  }
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

function bufferToImageBlock(buf, mediaType = 'image/jpeg') {
  return {
    type: 'image',
    source: { type: 'base64', media_type: mediaType, data: buf.toString('base64') },
  };
}

async function buildImageBlocks(mediaList) {
  const blocks = [];
  for (const m of mediaList) {
    if (m.type === 'video' || m.type === 'animated_gif') {
      const variants = (m.variants || []).filter((v) => v.content_type === 'video/mp4');
      variants.sort((a, b) => (b.bit_rate || 0) - (a.bit_rate || 0));
      const mp4 = variants[0];
      if (mp4) {
        try {
          const frames = await extractVideoFrames(mp4.url, 3);
          for (const buf of frames) blocks.push(bufferToImageBlock(buf));
          console.log(`Extracted ${frames.length} frames from video`);
          continue;
        } catch (e) {
          console.error('Video frame extraction failed:', e.message);
        }
      }
    }
    const url = m.url || m.preview_image_url;
    if (!url) continue;
    try {
      blocks.push(await urlToImageBlock(url));
    } catch (e) {
      console.error('Image fetch failed:', url, e.message);
    }
  }
  return blocks;
}

async function identifyMovie(tweetText, imageBlocks, replies = []) {
  const content = [...imageBlocks];
  const repliesBlock = replies.length > 0
    ? `\n\nTop replies under the tweet, sorted by likes (the most-liked reply is usually the answer for "what is this from?" tweets). IGNORE jokes, reactions, and replies that don't explicitly name a film or show — only use replies that mention a specific title:\n"""\n${replies.map((r, i) => `${i + 1}. [${r.likes} likes] ${r.text}`).join('\n')}\n"""`
    : '';
  content.push({
    type: 'text',
    text: `Identify the top 3 candidate movies OR TV series that the following tweet text, replies and (if present) images/video frames could be referring to, ranked by likelihood. Return the result as a JSON array only (no markdown, no commentary), each item with: title (original English), year (number — release year for movies, first air year for TV), type ("movie" or "tv"), confidence (0-100 number). Example output:
[{"title":"Prisoners","year":2013,"type":"movie","confidence":75},{"title":"Breaking Bad","year":2008,"type":"tv","confidence":15},{"title":"Zodiac","year":2007,"type":"movie","confidence":10}]

If you cannot identify any plausible candidates, return the empty array [].

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
        type: c.type === 'tv' ? 'tv' : 'movie',
        confidence: c.confidence != null ? Number(c.confidence) : null,
      }));
  } catch (e) {
    console.error('Candidate JSON parse failed:', e.message, 'raw:', raw);
    return [];
  }
}

async function searchTitle(query, type = 'movie') {
  const m = query.match(/^(.+?)\s*\((\d{4})\)\s*$/);
  const title = m ? m[1].trim() : query;
  const year = m ? m[2] : null;
  const params = new URLSearchParams({
    api_key: TMDB_API_KEY,
    query: title,
    language: 'en-US',
  });
  if (year) params.set(type === 'tv' ? 'first_air_date_year' : 'year', year);
  const res = await axios.get(`https://api.themoviedb.org/3/search/${type}?${params}`);
  return res.data.results[0];
}

async function searchMulti(query, n = 3) {
  const params = new URLSearchParams({
    api_key: TMDB_API_KEY,
    query,
    language: 'en-US',
    include_adult: 'false',
  });
  const res = await axios.get(`https://api.themoviedb.org/3/search/multi?${params}`);
  return (res.data.results || [])
    .filter((r) => r.media_type === 'movie' || r.media_type === 'tv')
    .slice(0, n);
}

function tmdbResultToCandidate(r) {
  const isTv = r.media_type === 'tv';
  const dateStr = (isTv ? r.first_air_date : r.release_date) || '';
  const year = dateStr ? Number(dateStr.split('-')[0]) : null;
  return {
    title: isTv ? r.name : r.title,
    year: Number.isFinite(year) ? year : null,
    type: isTv ? 'tv' : 'movie',
    confidence: null,
    tmdb: r,
  };
}

async function getDetails(id, type) {
  const url = `https://api.themoviedb.org/3/${type}/${id}?api_key=${TMDB_API_KEY}&language=en-US`;
  return (await axios.get(url)).data;
}

async function getCredits(id, type) {
  const url = `https://api.themoviedb.org/3/${type}/${id}/credits?api_key=${TMDB_API_KEY}`;
  const res = await axios.get(url);
  return {
    cast: (res.data.cast || []).slice(0, 3),
    crew: res.data.crew || [],
  };
}

async function getProviders(id, type) {
  const url = `https://api.themoviedb.org/3/${type}/${id}/watch/providers?api_key=${TMDB_API_KEY}`;
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

async function buildTweetText(searchResult, type = 'movie') {
  const isTv = type === 'tv';
  const [{ cast, crew }, providers, details] = await Promise.all([
    getCredits(searchResult.id, type),
    getProviders(searchResult.id, type),
    getDetails(searchResult.id, type),
  ]);

  const title = isTv
    ? (details.name || searchResult.name)
    : (details.title || searchResult.title);

  const yearStart = ((isTv ? details.first_air_date : details.release_date) || '').split('-')[0];
  const yearEnd = isTv ? ((details.last_air_date || '').split('-')[0]) : null;
  const yearStr = isTv && yearEnd && yearEnd !== yearStart ? `${yearStart}-${yearEnd}` : yearStart;

  const genres = (details.genres || []).map((g) => g.name).join(' | ');

  let lengthStr;
  if (isTv) {
    const seasons = details.number_of_seasons;
    const episodes = details.number_of_episodes;
    const epRuntime = (details.episode_run_time || [])[0];
    const epPart = epRuntime ? ` (~${epRuntime}m/ep)` : '';
    lengthStr = `${seasons || '?'} seasons, ${episodes || '?'} episodes${epPart}`;
  } else {
    const hours = Math.floor((details.runtime || 0) / 60);
    const mins = (details.runtime || 0) % 60;
    lengthStr = `${hours}h ${mins}m`;
  }

  const overview = details.overview || searchResult.overview || '';
  const castTags = cast.map((p) => toHashtag(p.name)).join(' ');

  const creators = isTv
    ? (details.created_by || [])
    : crew.filter((p) => p.job === 'Director');
  const creatorLabel = isTv ? 'Creator' : 'Director';
  const creatorTags = creators.map((p) => toHashtag(p.name)).join(' ') || 'Unknown';

  const providerTags = providers.length > 0
    ? providers.map((p) => toHashtag(p.provider_name)).join(' ')
    : 'None';

  const rating = (searchResult.vote_average ?? details.vote_average ?? 0).toFixed(1);
  const icon = isTv ? '📺' : '🎥';
  const typeLabel = isTv ? 'Series' : 'Movie';

  return `${pickAdLine()}\n\n${icon} ${typeLabel}: ${title} (${yearStr})\n⭐ ${rating}/10\n🎞️ ${genres}\n⏱️ ${lengthStr}\n${overview}\n\n🎭 Cast\n${castTags}\n\n🎬 ${creatorLabel}\n${creatorTags}\n\n📺 Platforms\n${providerTags}\n\n#MovieMates`;
}

async function showPicker(chatId, candidates) {
  const sessionId = Math.random().toString(36).slice(2, 10);
  pendingPicks.set(sessionId, { candidates, expiresAt: Date.now() + PICK_TTL });
  const buttons = candidates.map((c, i) => {
    const typeLabel = c.type === 'tv' ? 'Dizi' : 'Film';
    const yearStr = c.year ? ` (${c.year})` : '';
    const confPrefix = c.confidence != null ? `%${c.confidence} — ` : '';
    return [{
      text: `${confPrefix}${c.title}${yearStr} — ${typeLabel}`,
      callback_data: `pick:${sessionId}:${i}`,
    }];
  });
  await tg('sendMessage', {
    chat_id: chatId,
    text: '🎬 Bunlardan hangisi?',
    reply_markup: { inline_keyboard: buttons },
  });
}

async function handleMessage(message) {
  const chatId = message.chat.id;
  if (String(chatId) !== ALLOWED_CHAT_ID) {
    console.log('Ignored message from unauthorized chat:', chatId);
    return;
  }
  const text = (message.text || message.caption || '').trim();
  const tweetId = extractTweetId(text);

  if (!tweetId) {
    if (text.length < 2) {
      await sendMessage(chatId, 'Send a tweet link or a movie/series title.');
      return;
    }
    await sendMessage(chatId, '🔎 Searching...');
    let results;
    try {
      results = await searchMulti(text);
    } catch (e) {
      console.error('Multi search failed:', e.message);
      await sendMessage(chatId, `Search failed: ${e.message}`);
      return;
    }
    if (results.length === 0) {
      await sendMessage(chatId, '❌ Not found on TMDB.');
      return;
    }
    await showPicker(chatId, results.map(tmdbResultToCandidate));
    return;
  }

  await sendMessage(chatId, '🔎 Analyzing tweet...');

  let tweetText = '';
  let mediaList = [];
  try {
    const tweet = await fetchTweet(tweetId);
    tweetText = tweet.data?.text || '';
    mediaList = tweet.includes?.media || [];
  } catch (e) {
    console.error('Tweet fetch failed:', e.message);
    await sendMessage(chatId, `Failed to fetch tweet: ${e.message}`);
    return;
  }

  const replies = await fetchTopReplies(tweetId, 5);
  if (replies.length > 0) console.log(`Using ${replies.length} top replies (top likes: ${replies[0].likes})`);

  const imageBlocks = await buildImageBlocks(mediaList);

  let candidates;
  try {
    candidates = await identifyMovie(tweetText, imageBlocks, replies);
  } catch (e) {
    console.error('Claude failed:', e.message);
    await sendMessage(chatId, `Movie identification failed: ${e.message}`);
    return;
  }

  if (!candidates || candidates.length === 0) {
    await sendMessage(chatId, '❌ Could not identify the movie.');
    return;
  }

  const validated = (await Promise.all(candidates.map(async (c) => {
    const query = c.year ? `${c.title} (${c.year})` : c.title;
    const tmdb = await searchTitle(query, c.type).catch((e) => {
      console.error('TMDB validation failed:', query, e.message);
      return null;
    });
    return tmdb ? { ...c, tmdb } : null;
  }))).filter(Boolean);

  console.log(`Validation: ${candidates.length} candidates → ${validated.length} on TMDB`);

  if (validated.length === 0) {
    await sendMessage(chatId, '❌ Could not identify the movie.');
    return;
  }

  await showPicker(chatId, validated);
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

  const result = candidate.tmdb;
  if (!result) {
    await sendMessage(chatId, '❌ Internal error: TMDB result missing.');
    return;
  }

  if (candidate.confidence != null) {
    await sendMessage(chatId, `🎯 Film tanıma doğruluk oranı: %${candidate.confidence}`);
  }
  const formatted = await buildTweetText(result, candidate.type);
  await sendMessage(chatId, formatted);
  if (result.poster_path) {
    await sendPhoto(chatId, `https://image.tmdb.org/t/p/w500${result.poster_path}`);
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

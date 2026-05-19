const express = require('express');
const { classifyMentions } = require('./mention-classifier');

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN || '';
const MINA_USER_ID = process.env.MINA_USER_ID || 'U0AR8CE8KCG';
const NWC_CHANNEL_ID = process.env.NWC_CHANNEL_ID || 'C0B0RK6J962';
const OVERDUE_HOURS = parseInt(process.env.MINA_OVERDUE_HOURS || '24', 10);
const LOOKBACK_DAYS = parseInt(process.env.MINA_LOOKBACK_DAYS || '14', 10);

const CACHE_TTL_MS = 60 * 1000;
let cache = { data: null, ts: 0 };

let userCache = { data: null, ts: 0 };
const USER_CACHE_TTL_MS = 30 * 60 * 1000;

async function slackApi(method, params = {}) {
  const url = new URL(`https://slack.com/api/${method}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` },
  });
  const data = await res.json();
  if (!data.ok) {
    const err = new Error(`Slack API error: ${data.error}`);
    err.slackError = data.error;
    throw err;
  }
  return data;
}

async function loadUsers() {
  if (userCache.data && Date.now() - userCache.ts < USER_CACHE_TTL_MS) {
    return userCache.data;
  }
  const map = {};
  let cursor;
  do {
    const data = await slackApi('users.list', { limit: 200, cursor });
    for (const m of data.members || []) {
      if (m.deleted) continue;
      const profile = m.profile || {};
      map[m.id] = {
        id: m.id,
        name: profile.display_name || m.real_name || m.name || m.id,
        realName: m.real_name || m.name || '',
        avatar: profile.image_48 || profile.image_72 || '',
        isBot: !!m.is_bot,
      };
    }
    cursor = data.response_metadata?.next_cursor;
  } while (cursor);
  userCache = { data: map, ts: Date.now() };
  return map;
}

function buildPermalink(channelId, ts) {
  const tsClean = String(ts).replace('.', '');
  return `https://app.slack.com/client/-/${channelId}/p${tsClean}`;
}

function buildArchiveLink(channelId, ts, threadTs) {
  const tsClean = String(ts).replace('.', '');
  let url = `https://app.slack.com/archives/${channelId}/p${tsClean}`;
  if (threadTs && threadTs !== ts) {
    url += `?thread_ts=${threadTs}&cid=${channelId}`;
  }
  return url;
}

const TOPIC_KEYWORDS = {
  '註冊/登入': ['註冊', '登入', '一鍵註冊', '手機號', '密碼', '驗證碼', '簡訊'],
  '直播間': ['直播間', 'PK', '紅包雨', '直播間禮物'],
  '直播大廳': ['直播大廳'],
  '直播全屏': ['直播全屏', '全屏', '橫屏', '轉橫'],
  '主播列表': ['主播列表'],
  '主播關注': ['關注人數', '關注主播', '已關注', '未關注'],
  '廣場/類別': ['廣場', '類別', '頁籤', '熱門', '體育', '競猜'],
  '宣傳圖': ['宣傳圖'],
  '充值/禮金': ['充值', '存款', '禮包', '禮金', '首存', '回饋'],
  '禮物/送禮': ['送禮', '送禮物', '禮物'],
  '任務/簽到': ['任務系統', '簽到', '日常任務'],
  '個人中心': ['個人中心', '錢包', '我的頁面', '我的帳號'],
  '客服': ['客服'],
  '排程/人力': ['人力安排', 'Sprint', '排程', '派單', '工單'],
};

function extractTopics(text) {
  if (!text) return [];
  const hits = new Set();
  for (const [topic, kws] of Object.entries(TOPIC_KEYWORDS)) {
    for (const kw of kws) {
      if (text.includes(kw)) {
        hits.add(topic);
        break;
      }
    }
  }
  return [...hits];
}

function extractJiraTickets(text) {
  if (!text) return [];
  const matches = text.matchAll(/\b((?:NWC|GOR|TSD|MGYY|SA)-\d+)\b/g);
  return [...new Set([...matches].map(m => m[1]))];
}

function extractFiles(slackFiles) {
  if (!Array.isArray(slackFiles)) return [];
  return slackFiles.filter(f => f && f.id).map(f => ({
    id: f.id,
    name: f.name || f.title || 'file',
    mimetype: f.mimetype || '',
    isImage: (f.mimetype || '').startsWith('image/'),
    thumbUrl: f.thumb_360 || f.thumb_480 || f.thumb_720 || null,
    originalUrl: f.url_private || null,
    permalink: f.permalink || null,
    size: f.size || null,
  }));
}

function resolveMentions(text, users) {
  if (!text) return '';
  return text.replace(/<@([A-Z0-9]+)>/g, (_, uid) => {
    const u = users[uid];
    return u ? `@${u.name}` : `@${uid}`;
  }).replace(/<#[A-Z0-9]+\|([^>]+)>/g, '#$1');
}

function preview(text, maxLen = 240) {
  if (!text) return '';
  const cleaned = text.replace(/<[^|>]+\|([^>]+)>/g, '$2')
    .replace(/<([^>]+)>/g, '$1')
    .replace(/\s+/g, ' ').trim();
  return cleaned.length > maxLen ? cleaned.slice(0, maxLen) + '…' : cleaned;
}

async function collectMentions() {
  if (!SLACK_BOT_TOKEN) {
    return { error: 'SLACK_BOT_TOKEN not configured', mentions: [] };
  }

  const oldest = Math.floor(Date.now() / 1000) - LOOKBACK_DAYS * 86400;
  const users = await loadUsers();

  const history = await slackApi('conversations.history', {
    channel: NWC_CHANNEL_ID,
    oldest,
    limit: 200,
  });

  const mentionPattern = new RegExp(`<@${MINA_USER_ID}>`);
  const candidates = (history.messages || []).filter(m => {
    if (m.subtype === 'channel_join' || m.subtype === 'bot_message') return false;
    if (m.user === MINA_USER_ID) return false;
    return mentionPattern.test(m.text || '');
  });

  const mentions = [];
  for (const msg of candidates) {
    let minaReplied = false;
    let minaReplyTs = null;
    let replyCount = 0;
    let replies = [];

    if (msg.thread_ts || msg.reply_count) {
      try {
        const data = await slackApi('conversations.replies', {
          channel: NWC_CHANNEL_ID,
          ts: msg.thread_ts || msg.ts,
          limit: 100,
        });
        const all = data.messages || [];
        replyCount = Math.max(0, all.length - 1);
        for (const r of all) {
          if (r.ts === msg.ts) continue;
          const ru = users[r.user] || { id: r.user, name: r.user || 'Unknown', avatar: '' };
          const isMina = r.user === MINA_USER_ID;
          replies.push({
            ts: r.ts,
            tsIso: new Date(Number(r.ts) * 1000).toISOString(),
            user: { id: ru.id, name: ru.name, avatar: ru.avatar },
            isMina,
            text: resolveMentions(r.text || '', users),
            files: extractFiles(r.files),
          });
          if (isMina) {
            minaReplied = true;
            if (!minaReplyTs || Number(r.ts) < Number(minaReplyTs)) {
              minaReplyTs = r.ts;
            }
          }
        }
      } catch (e) {
        console.error(`Failed to fetch replies for ${msg.ts}:`, e.slackError || e.message);
      }
    }

    const tsNum = Number(msg.ts);
    const ageHours = (Date.now() / 1000 - tsNum) / 3600;
    let status;
    if (minaReplied) status = 'closed';
    else if (ageHours >= OVERDUE_HOURS) status = 'overdue';
    else status = 'pending';

    const asker = users[msg.user] || { id: msg.user, name: msg.user || 'Unknown', avatar: '' };
    const fullText = resolveMentions(msg.text || '', users);

    const allText = fullText + '\n' + replies.map(r => r.text).join('\n');

    mentions.push({
      ts: msg.ts,
      tsIso: new Date(tsNum * 1000).toISOString(),
      ageHours: Math.round(ageHours * 10) / 10,
      status,
      asker: { id: asker.id, name: asker.name, avatar: asker.avatar },
      text: preview(fullText),
      fullText,
      files: extractFiles(msg.files),
      replyCount,
      replies,
      minaReplyTs,
      minaReplyAgeHours: minaReplyTs ? Math.round((Date.now() / 1000 - Number(minaReplyTs)) / 3600 * 10) / 10 : null,
      permalink: buildArchiveLink(NWC_CHANNEL_ID, msg.ts),
      topics: extractTopics(allText),
      jiraTickets: extractJiraTickets(allText),
    });
  }

  mentions.sort((a, b) => Number(b.ts) - Number(a.ts));

  const classified = await classifyMentions(mentions);
  mentions.splice(0, mentions.length, ...classified);

  const needsReply = m => m.aiJudgment?.needsReply !== false;
  const byAsker = {};
  const byTopic = {};
  for (const m of mentions) {
    const k = m.asker.id || m.asker.name;
    byAsker[k] = byAsker[k] || { id: k, name: m.asker.name, avatar: m.asker.avatar, count: 0 };
    byAsker[k].count++;
    for (const t of m.topics || []) {
      byTopic[t] = (byTopic[t] || 0) + 1;
    }
  }
  const stats = {
    pending: mentions.filter(m => m.status === 'pending').length,
    overdue: mentions.filter(m => m.status === 'overdue').length,
    closed: mentions.filter(m => m.status === 'closed').length,
    total: mentions.length,
    actionable: mentions.filter(m => m.status !== 'closed' && needsReply(m)).length,
    skippable: mentions.filter(m => m.status !== 'closed' && !needsReply(m)).length,
    byAsker: Object.values(byAsker).sort((a, b) => b.count - a.count),
    byTopic: Object.entries(byTopic).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
  };

  return {
    mentions,
    stats,
    meta: {
      channel: NWC_CHANNEL_ID,
      minaUserId: MINA_USER_ID,
      lookbackDays: LOOKBACK_DAYS,
      overdueHours: OVERDUE_HOURS,
      generatedAt: new Date().toISOString(),
    },
  };
}

function createMinaMentionsRouter() {
  const router = express.Router();

  router.get('/mina-mentions', async (req, res) => {
    const force = req.query.refresh === '1';
    if (!force && cache.data && Date.now() - cache.ts < CACHE_TTL_MS) {
      return res.json({ ...cache.data, cached: true, cacheAgeMs: Date.now() - cache.ts });
    }
    try {
      const data = await collectMentions();
      cache = { data, ts: Date.now() };
      res.json({ ...data, cached: false });
    } catch (e) {
      console.error('mina-mentions error:', e);
      res.status(500).json({ error: e.message, slackError: e.slackError });
    }
  });

  router.get('/slack-file', async (req, res) => {
    const { url } = req.query;
    if (!url || typeof url !== 'string') {
      return res.status(400).json({ error: 'missing url param' });
    }
    if (!url.startsWith('https://files.slack.com/') && !url.startsWith('https://slack.com/')) {
      return res.status(403).json({ error: 'forbidden host' });
    }
    if (!SLACK_BOT_TOKEN) {
      return res.status(500).json({ error: 'SLACK_BOT_TOKEN not configured' });
    }
    try {
      const upstream = await fetch(url, {
        headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` },
      });
      if (!upstream.ok) {
        return res.status(upstream.status).send(`upstream ${upstream.status}`);
      }
      const ct = upstream.headers.get('content-type') || 'application/octet-stream';
      if (ct.startsWith('text/html')) {
        return res.status(502).json({ error: 'upstream returned HTML (auth issue?)' });
      }
      res.setHeader('Content-Type', ct);
      res.setHeader('Cache-Control', 'private, max-age=3600');
      const buf = Buffer.from(await upstream.arrayBuffer());
      res.send(buf);
    } catch (e) {
      console.error('slack-file proxy error:', e);
      res.status(500).json({ error: e.message });
    }
  });

  return router;
}

module.exports = { createMinaMentionsRouter };

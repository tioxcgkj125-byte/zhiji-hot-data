/* 知己工作台热榜抓取脚本（GitHub Actions 定时运行）
   模式一（默认）：B站 AI 综合榜（严格过滤）+ 抖音热点榜 + 小红书热榜 + X AI 动态 + 预抓 AI 细分频道
   模式二（按需）：node fetch.js --search "关键词"  ← 由 worker 的 repository_dispatch 触发，搜任意词 */
const fs = require('fs');
const path = require('path');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/* AI 综合榜：搜索关键词 + 标题严格过滤 */
const AI_SEARCH_KW = ['AI', '人工智能', '大模型'];
const AI_TITLE_RE = /\bai\b|(?:人工|机器)智能|大模型|gpt|llm|智能体|agent|deepseek|claude|gemini|openai|chatgpt|机器学习|神经网络|aigc|ai绘画|ai视频|ai修复/i;

/* AI 细分频道（预抓，即点即看） */
const CHANNELS = [
  'AI 新闻', 'AI 编程', 'AI 绘画', 'AI 视频', 'AI 工具', 'AI 副业',
  'AI 教程', '大模型', 'ChatGPT', 'DeepSeek', 'Claude', '智能体',
  '数字人', 'Sora', 'AI 音乐', 'ComfyUI',
];

/* X AI 动态：对标账号（官方号 + 大V + 中文 AI 资讯号） */
const X_ACCOUNTS = [
  'OpenAI', 'xai', 'AnthropicAI', 'GoogleDeepMind', 'MistralAI',
  'karpathy', 'elonmusk', '_akhaliq', 'op7418', 'dotey',
];

const safeName = (kw) => kw.replace(/[\\/:*?"<>|#%&{}$!'@+`=\r\n]+/g, ' ').trim();

function save(relPath, data) {
  const p = path.join(__dirname, 'data', relPath);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data));
  console.log('saved ' + relPath + ': ' + ((data.items && data.items.length) || '-'));
}

async function getBiliCookie() {
  try {
    const r = await fetch('https://api.bilibili.com/x/frontend/finger/spi', {
      headers: { 'User-Agent': UA, Referer: 'https://www.bilibili.com/' },
    });
    const d = await r.json();
    if (d && d.code === 0 && d.data && d.data.b_3) {
      return 'buvid3=' + d.data.b_3 + '; buvid4=' + (d.data.b_4 || '');
    }
  } catch (e) { console.log('spi failed: ' + String(e)); }
  return '';
}

/* ---------- B站搜索（通用）：综合排序 + 限定天数内 ---------- */
async function biliSearch(headers, kw, days, titleFilter) {
  const since = Math.floor(Date.now() / 1000) - days * 86400;
  const items = [];
  try {
    const url =
      'https://api.bilibili.com/x/web-interface/search/type?search_type=video&keyword=' +
      encodeURIComponent(kw) + '&order=totalrank&page=1';
    const r = await fetch(url, { headers });
    const d = await r.json();
    if (d.code !== 0 || !d.data || !Array.isArray(d.data.result)) {
      console.log('search bad response for ' + kw + ' code=' + d.code);
      return [];
    }
    for (const v of d.data.result) {
      const title = String(v.title || '').replace(/<[^>]+>/g, '');
      if (titleFilter && !titleFilter.test(title)) continue;
      if ((v.pubdate || 0) < since) continue;
      const pic = String(v.pic || '');
      items.push({
        title,
        url: 'https://www.bilibili.com/video/' + v.bvid,
        author: v.author || '',
        cover: pic.startsWith('//') ? 'https:' + pic : pic,
        views: v.play || 0,
        likes: v.like || 0,
        pubDate: (v.pubdate || 0) * 1000,
      });
    }
  } catch (e) { console.log('search error for ' + kw + ': ' + String(e)); }
  items.sort((a, b) => b.views - a.views);
  return items.slice(0, 20).map((v, i) => ({ rank: i + 1, ...v }));
}

/* ---------- B站全站热门（回退） ---------- */
async function fetchBilibiliPopular(headers) {
  const endpoints = [
    'https://api.bilibili.com/x/web-interface/popular?ps=20&pn=1',
    'https://api.bilibili.com/x/web-interface/ranking/v2?rid=0&type=all',
  ];
  for (const ep of endpoints) {
    try {
      const r = await fetch(ep, { headers });
      const d = await r.json();
      if (d.code === 0 && d.data && Array.isArray(d.data.list) && d.data.list.length) {
        return d.data.list.slice(0, 20).map((v, i) => ({
          rank: i + 1,
          title: v.title,
          url: 'https://www.bilibili.com/video/' + v.bvid,
          author: v.owner ? v.owner.name : '',
          cover: (v.pic || '').replace('http://', 'https://'),
          views: v.stat ? v.stat.view : 0,
          likes: v.stat ? v.stat.like : 0,
          pubDate: (v.pubdate || 0) * 1000,
        }));
      }
      console.log('bilibili endpoint bad: ' + ep + ' code=' + d.code);
    } catch (e) { console.log('bilibili endpoint error: ' + ep + ' ' + String(e)); }
  }
  return null;
}

/* ---------- 抖音 ---------- */
async function fetchDouyin() {
  try {
    const r0 = await fetch('https://www.douyin.com/passport/general/login_guiding_strategy/?aid=6383', {
      headers: { 'User-Agent': UA, Referer: 'https://www.douyin.com/' },
    });
    const m = /passport_csrf_token=([^;]+)/.exec(r0.headers.get('set-cookie') || '');
    const token = m ? m[1] : '';
    const r = await fetch(
      'https://www.douyin.com/aweme/v1/web/hot/search/list/?device_platform=webapp&aid=6383&channel=channel_pc_web&detail_list=1',
      {
        headers: {
          'User-Agent': UA,
          Referer: 'https://www.douyin.com/',
          ...(token ? { Cookie: 'passport_csrf_token=' + token } : {}),
        },
      }
    );
    const d = await r.json();
    const dd = d && d.data;
    const list = (dd && (dd.word_list || dd.trending_list)) || [];
    if (Array.isArray(list) && list.length) {
      return list.slice(0, 20).map((v, i) => ({
        rank: i + 1,
        title: v.word || v.title || '',
        url: 'https://www.douyin.com/hot/' + (v.sentence_id || v.group_id || ''),
        author: '',
        cover: (v.word_cover && Array.isArray(v.word_cover.url_list) && v.word_cover.url_list[0]) || '',
        views: v.hot_value || 0,
        likes: 0,
        pubDate: Date.parse(v.event_time || '') || 0,
      })).filter((v) => v.title);
    }
    console.log('douyin bad response: ' + JSON.stringify(d).slice(0, 200));
  } catch (e) { console.log('douyin error: ' + String(e)); }
  return null;
}

/* ---------- 小红书热榜（60s 开源聚合 API，免认证） ---------- */
function parseScore(s) {
  const str = String(s || '').trim();
  const m = /^([\d.]+)\s*(w|万)$/i.exec(str);
  if (m) return Math.round(parseFloat(m[1]) * 10000);
  return parseInt(str.replace(/[^\d]/g, ''), 10) || 0;
}

async function fetchXiaohongshu() {
  try {
    const r = await fetch('https://60s.viki.moe/v2/rednote', {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
    });
    const d = await r.json();
    const list = d && d.code === 200 && Array.isArray(d.data) ? d.data : [];
    if (list.length) {
      return list.slice(0, 20).map((v, i) => ({
        rank: i + 1,
        title: v.title || '',
        url: v.link || '',
        author: '',
        cover: '',
        views: parseScore(v.score),
        likes: 0,
        pubDate: 0,
      })).filter((v) => v.title && v.url);
    }
    console.log('xhs empty: ' + JSON.stringify(d).slice(0, 200));
  } catch (e) { console.log('xhs error: ' + String(e)); }
  return null;
}

/* ---------- X AI 动态（官方 syndication 接口，免登录） ---------- */
async function fetchXTimeline(handle) {
  const r = await fetch(
    'https://syndication.twitter.com/srv/timeline-profile/screen-name/' + encodeURIComponent(handle) + '?showReplies=false',
    {
      headers: {
        'User-Agent': UA,
        Accept: 'text/html,application/xhtml+xml',
        Referer: 'https://platform.twitter.com/',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    }
  );
  if (!r.ok) throw new Error('X_' + handle + '_HTTP_' + r.status);
  const t = await r.text();
  const m = /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/.exec(t);
  if (!m) throw new Error('X_' + handle + '_NO_DATA');
  const d = JSON.parse(m[1]);
  const entries = (d.props && d.props.pageProps && d.props.pageProps.timeline && d.props.pageProps.timeline.entries) || [];
  const out = [];
  for (const e of entries) {
    const tw = e.content && e.content.tweet;
    if (!tw) continue;
    const user = tw.user || {};
    const text = String(tw.full_text || tw.text || '')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
      .replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const media = (tw.entities && tw.entities.media) || (tw.extended_entities && tw.extended_entities.media) || [];
    const cover = media[0] && media[0].media_url_https ? media[0].media_url_https : '';
    const tid = tw.conversation_id_str || String(e.entry_id || '').replace(/^tweet-/, '');
    out.push({
      title: text.length > 160 ? text.slice(0, 160) + '…' : text,
      url: 'https://x.com/' + (user.screen_name || handle) + '/status/' + tid,
      author: (user.name || handle) + (user.screen_name ? ' @' + user.screen_name : ''),
      cover,
      views: 0,
      likes: tw.favorite_count || 0,
      pubDate: Date.parse(tw.created_at || '') || 0,
    });
  }
  return out.slice(0, 3); // 每账号最新 3 条
}

async function fetchX() {
  const all = [];
  for (const handle of X_ACCOUNTS) {
    try {
      const items = await fetchXTimeline(handle);
      all.push(...items);
    } catch (e) { console.log('x account failed: ' + String(e && e.message || e)); }
    await sleep(800);
  }
  all.sort((a, b) => b.pubDate - a.pubDate);
  return all.slice(0, 30).map((v, i) => ({ rank: i + 1, ...v }));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const argv = process.argv;
  const si = argv.indexOf('--search');
  const cookie = await getBiliCookie();
  const headers = {
    'User-Agent': UA,
    Referer: 'https://www.bilibili.com/',
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9',
    ...(cookie ? { Cookie: cookie } : {}),
  };

  /* 模式二：按需搜索任意关键词（repository_dispatch 触发） */
  if (si !== -1 && argv[si + 1]) {
    const kw = safeName(String(argv[si + 1]).slice(0, 30));
    const items = await biliSearch(headers, kw, 30, null);
    if (items.length) {
      save('search/' + kw + '.json', { platform: 'bilibili', kw, items, fetchedAt: Date.now() });
      return;
    }
    console.error('SEARCH_EMPTY: ' + kw);
    process.exit(1);
  }

  /* 模式一：定时全量抓取 */

  // 1. B站 AI 综合榜（严格过滤，失败回退全站热门）
  let bili = null;
  const seen = new Set();
  const all = [];
  for (const kw of AI_SEARCH_KW) {
    const items = await biliSearch(headers, kw, 7, AI_TITLE_RE);
    for (const it of items) {
      if (seen.has(it.url)) continue;
      seen.add(it.url);
      all.push(it);
    }
  }
  all.sort((a, b) => b.views - a.views);
  bili = all.slice(0, 20).map((v, i) => ({ rank: i + 1, ...v }));
  if (!bili || bili.length < 8) {
    console.log('AI search insufficient (' + (bili ? bili.length : 0) + '), fallback to popular');
    bili = await fetchBilibiliPopular(headers);
  }
  if (bili) save('bilibili.json', { platform: 'bilibili', items: bili, fetchedAt: Date.now() });

  // 2. AI 细分频道预抓（30 天内，宽松过滤：频道词已足够定向）
  for (const ch of CHANNELS) {
    await sleep(1500); // 礼貌间隔，降低风控风险
    const items = await biliSearch(headers, ch, 30, null);
    if (items.length) save('search/' + ch + '.json', { platform: 'bilibili', kw: ch, items, fetchedAt: Date.now() });
  }
  save('channels.json', { channels: CHANNELS, fetchedAt: Date.now() });

  // 3. 抖音热点榜
  const dy = await fetchDouyin();
  if (dy) save('douyin.json', { platform: 'douyin', items: dy, fetchedAt: Date.now() });

  // 4. 小红书热榜
  const xhs = await fetchXiaohongshu();
  if (xhs) save('xiaohongshu.json', { platform: 'xiaohongshu', items: xhs, fetchedAt: Date.now() });

  // 5. X AI 动态（对标账号）
  const x = await fetchX();
  if (x && x.length) save('x.json', { platform: 'x', items: x, fetchedAt: Date.now() });

  if (!bili) { console.error('BILIBILI FAILED'); process.exit(1); }
})();

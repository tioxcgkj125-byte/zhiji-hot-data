/* 知己工作台热榜抓取脚本（GitHub Actions 定时运行）
   模式一（默认）：B站 AI 综合榜（严格过滤）+ 抖音热点榜 + 预抓 AI 细分频道
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

  if (!bili) { console.error('BILIBILI FAILED'); process.exit(1); }
})();

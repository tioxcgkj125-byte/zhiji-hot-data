/* 知己工作台热榜抓取脚本（GitHub Actions 定时运行）
   模式一（默认）：B站 AI 综合榜（严格过滤）+ 抖音热点榜 + 预抓 AI 细分频道
   模式二（按需）：node fetch.js --search "关键词"  ← 由 worker 的 repository_dispatch 触发，搜任意词
   注：小红书/X 由 Cloudflare Worker 直接抓取（见 zhiji-workbench/worker.js），不经此脚本 */
const fs = require('fs');
const path = require('path');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/* AI 综合榜：搜索关键词 + 标题严格过滤 */
const AI_SEARCH_KW = ['AI', '人工智能', '大模型'];
const AI_TITLE_RE = /\bai\b|(?:人工|机器)智能|大模型|gpt|llm|智能体|agent|deepseek|claude|gemini|openai|chatgpt|机器学习|神经网络|aigc|ai绘画|ai视频|ai修复/i;

/* 只预抓“作品/创作”频道，避免 AI 新闻、编程、课程、大模型综述混进情报页 */
const CHANNELS = ['AI 视频', 'AI 短剧', 'AI 动画', 'AI 电影', 'Sora', '可灵'];

/* 全部内容只保留近 7 天：保证看到的是当下最热，不是陈年热点 */
const FRESH_DAYS = 7;

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

/* ---------- 快手公开热榜（解析首页 Apollo State，复用 DailyHotApi/NewsNow 的免费方案） ---------- */
async function fetchKuaishou() {
  try {
    const r = await fetch('https://www.kuaishou.com/?isHome=1', {
      headers: {
        'User-Agent': UA,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        Referer: 'https://www.kuaishou.com/',
      },
      signal: AbortSignal.timeout(45000),
    });
    const html = await r.text();
    const m = /window\.__APOLLO_STATE__\s*=\s*(\{[\s\S]+?\});/.exec(html);
    if (!m) {
      console.log('kuaishou no apollo state, len=' + html.length);
      return null;
    }
    const state = JSON.parse(m[1]);
    const data = (state && state.defaultClient) || {};
    const roots = [
      data['$ROOT_QUERY.visionHotRank({"page":"home"})'],
      data['$ROOT_QUERY.visionHotRank({"page":"home","platform":"web"})'],
    ].filter(Boolean);
    let all = [];
    for (const root of roots) {
      if (Array.isArray(root.items)) { all = root.items; break; }
      if (root.id && data[root.id] && Array.isArray(data[root.id].items)) {
        all = data[root.id].items;
        break;
      }
    }
    const items = all.map((entry) => {
      const item = data[entry.id];
      if (!item || !item.name) return null;
      const photoId = item.photoIds && Array.isArray(item.photoIds.json) ? item.photoIds.json[0] : '';
      let cover = String(item.poster || '');
      try { cover = cover ? decodeURIComponent(cover) : ''; } catch {}
      return {
        title: String(item.name).slice(0, 160),
        url: photoId ? 'https://www.kuaishou.com/short-video/' + photoId : 'https://www.kuaishou.com/',
        author: '',
        cover,
        views: Number(String(item.hotValue || '').replace(/[^\d.]/g, '')) || 0,
        likes: 0,
        pubDate: 0,
        channel: '公开热榜',
      };
    }).filter((item) => item && item.title);
    return items.length ? items.slice(0, 50) : null;
  } catch (e) {
    console.log('kuaishou error: ' + String(e));
    return null;
  }
}

/* ---------- 公众号搜狗搜索（免登录；复用 wechat-article-search 的公开解析思路） ---------- */
function stripHtml(value) {
  return String(value || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&#(\d+);/g, function (raw, n) {
      const cp = Number(n);
      return cp >= 0xd800 && cp <= 0xdfff ? raw : String.fromCodePoint(cp);
    })
    .replace(/&ldquo;/g, '“').replace(/&rdquo;/g, '”')
    .replace(/&mdash;/g, '—').replace(/&hellip;/g, '…')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ').trim();
}

async function fetchWechat() {
  const keywords = ['AI视频', 'AI短剧'];
  const all = [];
  for (const keyword of keywords) {
    try {
      const url = 'https://weixin.sogou.com/weixin?type=2&query=' + encodeURIComponent(keyword) + '&ie=utf8';
      const r = await fetch(url, {
        headers: {
          'User-Agent': UA,
          Accept: 'text/html,application/xhtml+xml',
          'Accept-Language': 'zh-CN,zh;q=0.9',
          Referer: 'https://weixin.sogou.com/',
        },
        signal: AbortSignal.timeout(25000),
      });
      const html = await r.text();
      const blocks = html.split(/<li id="sogou_vr_11002601_box_/).slice(1);
      for (const block of blocks) {
        const hit = /<h3[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(block);
        if (!hit) continue;
        const title = stripHtml(hit[2]).slice(0, 300);
        if (!title) continue;
        let href = hit[1].replace(/&amp;/g, '&');
        if (href.startsWith('/link?')) href = 'https://weixin.sogou.com' + href;
        const ts = /timeConvert\('(\d+)'\)/.exec(block);
        all.push({
          title,
          url: href,
          author: '',
          cover: '',
          views: 0,
          likes: 0,
          pubDate: ts ? Number(ts[1]) * 1000 : 0,
          channel: '搜索:' + keyword,
        });
      }
      await sleep(500);
    } catch (e) {
      console.log('wechat ' + keyword + ' error: ' + String(e));
    }
  }
  return all.length ? all.slice(0, 40) : null;
}

/* ---------- X 指定账号时间线：先 syndication，失败再用 Jina Reader（都是免费公开源） ---------- */
const X_ACCOUNTS = ['runwayml', 'Kling_ai', 'Pika_Labs', 'HeyGen', 'hedra_labs', 'LumaLabsAI', 'krea_ai'];

async function fetchXSyndication(handle) {
  const url = 'https://syndication.twitter.com/srv/timeline-profile/screen-name/' +
    encodeURIComponent(handle) + '?showReplies=false';
  const r = await fetch(url, {
    headers: {
      'User-Agent': UA,
      Accept: 'text/html,application/xhtml+xml',
      Referer: 'https://platform.twitter.com/',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    signal: AbortSignal.timeout(25000),
  });
  if (!r.ok) throw new Error('HTTP_' + r.status);
  const html = await r.text();
  const m = /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/.exec(html);
  if (!m) throw new Error('NO_NEXT_DATA');
  const d = JSON.parse(m[1]);
  const entries = (d && d.props && d.props.pageProps && d.props.pageProps.timeline &&
    d.props.pageProps.timeline.entries) || [];
  const out = [];
  for (const e of entries) {
    const tw = e.content && e.content.tweet;
    if (!tw) continue;
    const user = tw.user || {};
    const text = String(tw.full_text || tw.text || '')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const media = (tw.entities && tw.entities.media) ||
      (tw.extended_entities && tw.extended_entities.media) || [];
    const cover = (media[0] && media[0].media_url_https) ||
      String(user.profile_image_url_https || '').replace(/_normal(\.\w+)$/, '$1');
    const tid = tw.conversation_id_str || String(e.entry_id || '').replace(/^tweet-/, '');
    out.push({
      title: text.length > 300 ? text.slice(0, 300) : text,
      url: 'https://x.com/' + (user.screen_name || handle) + '/status/' + tid,
      author: '@' + (user.screen_name || handle),
      cover,
      views: 0,
      likes: tw.favorite_count || 0,
      pubDate: Date.parse(tw.created_at || '') || 0,
    });
  }
  return out.slice(0, 10);
}

async function fetchXJina(handle) {
  const r = await fetch('https://r.jina.ai/http://x.com/' + encodeURIComponent(handle), {
    headers: {
      'User-Agent': UA,
      Accept: 'text/html',
      'X-Return-Format': 'html',
    },
    signal: AbortSignal.timeout(25000),
  });
  if (!r.ok) throw new Error('HTTP_' + r.status);
  const html = await r.text();
  const out = [];
  for (const match of html.matchAll(/<li>([\s\S]*?)<\/li>/g)) {
    const block = match[1];
    const href = /data-href="\/([^"/]+)\/status\/(\d+)"/.exec(block);
    if (!href) continue;
    const textMatch = /<div[^>]*class="[^"]*whitespace-pre-wrap[^"]*"[^>]*>\s*<span[^>]*>([\s\S]*?)<\/span>/.exec(block);
    const text = stripHtml(textMatch ? textMatch[1] : '');
    if (!text) continue;
    const media = /https:\/\/pbs\.twimg\.com\/(?:media|amplify_video_thumb|ext_tw_video_thumb)\/[^"'\s]+/.exec(block);
    out.push({
      title: text.slice(0, 300),
      url: 'https://x.com/' + href[1] + '/status/' + href[2],
      author: '@' + href[1],
      cover: media ? media[0].replace(/&amp;/g, '&') : '',
      views: 0,
      likes: 0,
      pubDate: 0,
    });
  }
  return out.slice(0, 10);
}

async function fetchX() {
  const all = [];
  for (const handle of X_ACCOUNTS) {
    let items = null;
    try { items = await fetchXSyndication(handle); }
    catch (e) { console.log('x syndication ' + handle + ': ' + String(e)); }
    if (!items || !items.length) {
      try { items = await fetchXJina(handle); }
      catch (e) { console.log('x jina ' + handle + ': ' + String(e)); }
    }
    if (items && items.length) all.push(...items);
    await sleep(800);
  }
  return all.length ? all : null;
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
    const items = await biliSearch(headers, kw, FRESH_DAYS, null);
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
    const items = await biliSearch(headers, kw, FRESH_DAYS, AI_TITLE_RE);
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

  // 2. AI 细分频道预抓（近 7 天，宽松过滤：频道词已足够定向）
  for (const ch of CHANNELS) {
    await sleep(1500); // 礼貌间隔，降低风控风险
    const items = await biliSearch(headers, ch, FRESH_DAYS, null);
    if (items.length) save('search/' + ch + '.json', { platform: 'bilibili', kw: ch, items, fetchedAt: Date.now() });
  }
  save('channels.json', { channels: CHANNELS, fetchedAt: Date.now() });

  // 3. 抖音热点榜
  const dy = await fetchDouyin();
  if (dy) save('douyin.json', { platform: 'douyin', items: dy, fetchedAt: Date.now() });

  // 4. 快手热点榜（免费公开 Apollo State）
  const ks = await fetchKuaishou();
  if (ks) save('kuaishou.json', { platform: 'kuaishou', items: ks, fetchedAt: Date.now() });

  // 5. 公众号搜狗搜索（免登录；失败时保留上一份文件）
  const wx = await fetchWechat();
  if (wx) save('wechat.json', { platform: 'wechat', items: wx, fetchedAt: Date.now() });

  // 6. X 指定账号时间线（syndication / Jina 免费源）
  const x = await fetchX();
  if (x) save('x.json', { platform: 'x', items: x, fetchedAt: Date.now() });

  if (!bili) { console.error('BILIBILI FAILED'); process.exit(1); }
})();

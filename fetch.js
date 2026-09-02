/* 知己工作台热榜抓取脚本（GitHub Actions 定时运行）
   - B站：AI 定向搜索（多关键词 + 标题过滤 + 7 天内 + 综合排序），失败回退全站热门
   - 抖音：全站热点榜（临时 csrf token），失败只告警，保留旧数据 */
const fs = require('fs');
const path = require('path');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/* AI 相关关键词：用于搜索 + 标题严格过滤 */
const AI_SEARCH_KW = ['AI', '人工智能', '大模型'];
const AI_TITLE_RE = /\bai\b|(?:人工|机器)智能|大模型|gpt|llm|智能体|agent|deepseek|claude|gemini|openai|chatgpt|机器学习|神经网络|aigc|ai绘画|ai视频|ai修复/i;

function save(name, data) {
  fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, 'data', name), JSON.stringify(data));
  console.log('saved ' + name + ': ' + data.items.length + ' items');
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

/* ---------- B站：AI 定向搜索 ---------- */
async function fetchBilibiliAISearch(headers) {
  const weekAgo = Math.floor(Date.now() / 1000) - 7 * 86400;
  const seen = new Set();
  const all = [];
  for (const kw of AI_SEARCH_KW) {
    try {
      const url =
        'https://api.bilibili.com/x/web-interface/search/type?search_type=video&keyword=' +
        encodeURIComponent(kw) + '&order=totalrank&page=1';
      const r = await fetch(url, { headers });
      const d = await r.json();
      if (d.code !== 0 || !d.data || !Array.isArray(d.data.result)) {
        console.log('search bad response for ' + kw + ' code=' + d.code);
        continue;
      }
      for (const v of d.data.result) {
        if (!v.bvid || seen.has(v.bvid)) continue;
        const title = String(v.title || '').replace(/<[^>]+>/g, '');
        if (!AI_TITLE_RE.test(title)) continue;
        if ((v.pubdate || 0) < weekAgo) continue;
        seen.add(v.bvid);
        const pic = String(v.pic || '');
        all.push({
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
  }
  all.sort((a, b) => b.views - a.views);
  return all.slice(0, 20).map((v, i) => ({ rank: i + 1, ...v }));
}

/* ---------- B站：全站热门（回退） ---------- */
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
    const list = d && d.data && d.data.word_list;
    if (Array.isArray(list) && list.length) {
      return list.slice(0, 20).map((v, i) => ({
        rank: i + 1,
        title: v.word,
        url: 'https://www.douyin.com/hot/' + v.sentence_id,
        author: '',
        cover: '',
        views: v.hot_value || 0,
        likes: 0,
        pubDate: Date.parse(v.event_time) || 0,
      }));
    }
    console.log('douyin bad response');
  } catch (e) { console.log('douyin error: ' + String(e)); }
  return null;
}

(async () => {
  const cookie = await getBiliCookie();
  const headers = {
    'User-Agent': UA,
    Referer: 'https://www.bilibili.com/',
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9',
    ...(cookie ? { Cookie: cookie } : {}),
  };

  // B站：优先 AI 定向搜索，数量不足则回退全站热门
  let bili = null;
  try { bili = await fetchBilibiliAISearch(headers); } catch (e) { console.log('AI search failed: ' + String(e)); }
  if (!bili || bili.length < 8) {
    console.log('AI search insufficient (' + (bili ? bili.length : 0) + '), fallback to popular');
    bili = await fetchBilibiliPopular(headers);
  }
  if (bili) save('bilibili.json', { platform: 'bilibili', items: bili, fetchedAt: Date.now() });

  const dy = await fetchDouyin();
  if (dy) save('douyin.json', { platform: 'douyin', items: dy, fetchedAt: Date.now() });

  if (!bili) { console.error('BILIBILI FAILED'); process.exit(1); }
})();

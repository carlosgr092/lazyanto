// Lazyanto background service worker — scrapes detail pages for each selected post

const activeJobs = new Map(); // tabId → {resolve, reject, timeout}

// Keep service worker alive during long scraping operations
let keepAliveTimer = null;
function startKeepAlive() {
  if (keepAliveTimer) return;
  keepAliveTimer = setInterval(() => chrome.runtime.getPlatformInfo(() => {}), 20000);
}
function stopKeepAlive() {
  clearInterval(keepAliveTimer);
  keepAliveTimer = null;
}

// ─── Tab load listener (top-level, required for MV3 SW) ──────────────────────
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status !== 'complete') return;
  const job = activeJobs.get(tabId);
  if (!job) return;
  clearTimeout(job.timeout);
  job.resolve(tabId);
});

// ─── Message listener ─────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type !== 'lzy:scrape') return;
  startKeepAlive();

  scrapeAll(msg.posts, msg.businessId, msg.assetId, sender.tab?.id)
    .then(results => {
      stopKeepAlive();
      sendResponse({ ok: true, results });
    })
    .catch(err => {
      stopKeepAlive();
      sendResponse({ ok: false, error: err.message });
    });

  return true; // keep message channel open for async response
});

// ─── Scrape all posts sequentially ───────────────────────────────────────────
async function scrapeAll(posts, businessId, assetId, callerTabId) {
  const results = [];
  for (let i = 0; i < posts.length; i++) {
    const post = posts[i];

    // Send progress update to content script
    if (callerTabId) {
      chrome.tabs.sendMessage(callerTabId, {
        type: 'lzy:progress',
        current: i + 1,
        total: posts.length,
        title: post.title
      }).catch(() => {});
    }

    const url = buildDetailUrl(businessId, assetId, post.contentId);
    try {
      const data = await scrapeTab(url);
      results.push({ ...post, ...(data || {}), ok: !!data });
    } catch (e) {
      results.push({ ...post, error: e.message, ok: false });
    }
  }
  return results;
}

function buildDetailUrl(businessId, assetId, contentId) {
  return `https://business.facebook.com/latest/insights/object_insights/?asset_id=${assetId}&business_id=${businessId}&ir_qe_exposed=1&content_id=${contentId}&nav_ref=bizweb_insights_uta_table`;
}

// ─── Open a tab, wait for load, extract data, close ──────────────────────────
async function scrapeTab(url) {
  const tabId = await new Promise((resolve, reject) => {
    chrome.tabs.create({ url, active: false }, (tab) => {
      if (chrome.runtime.lastError) { reject(new Error(chrome.runtime.lastError.message)); return; }
      const timeout = setTimeout(() => {
        activeJobs.delete(tab.id);
        chrome.tabs.remove(tab.id).catch(() => {});
        reject(new Error('Tab load timeout'));
      }, 30000);
      activeJobs.set(tab.id, { resolve, reject, timeout });
    });
  });

  // Wait for React to finish rendering after load complete
  await delay(3500);

  let result = null;
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId },
      func: extractDetailData
    });
    result = res?.result ?? null;
  } catch (e) {
    // page might have been closed or script injection failed
  }

  await chrome.tabs.remove(tabId).catch(() => {});
  activeJobs.delete(tabId);
  return result;
}

function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ─── Extractor — runs inside the detail page tab ──────────────────────────────
// Must be self-contained (no closures over external vars)
function extractDetailData() {
  const unwrapMetric = (value) => {
    if (value == null) return null;
    if (typeof value === 'number' || typeof value === 'string') return value;
    if (typeof value !== 'object') return null;

    const valueKeys = ['value', 'count', 'total', 'amount', 'text', 'formatted_value', 'formattedValue'];
    for (const key of valueKeys) {
      if (value[key] != null && typeof value[key] !== 'object') return value[key];
    }

    return null;
  };

  const pickMetric = (obj, keys) => {
    if (!obj || typeof obj !== 'object') return null;
    for (const key of keys) {
      if (obj[key] == null) continue;
      const metric = unwrapMetric(obj[key]);
      if (metric != null) return metric;
    }
    return null;
  };

  const mergeMetrics = (target, source) => {
    if (!source || typeof source !== 'object') return;
    const mappings = {
      views: ['views', 'view_count', 'views_count', 'video_views', 'video_view_count', 'post_views', 'reels_plays', 'plays', 'play_count'],
      viewers: ['viewers', 'viewer_count', 'reach', 'people_reached', 'unique_viewers', 'unique_views'],
      interactions: ['net_interaction', 'interactions', 'interaction_count', 'engagement', 'engagements', 'post_engagement']
    };

    for (const [field, keys] of Object.entries(mappings)) {
      if (target[field] != null) continue;
      const metric = pickMetric(source, keys);
      if (metric != null) target[field] = metric;
    }
  };

  const extractPageNameFromFeedPreview = () => {
    const labelRe = /^(Vista previa del feed|Feed preview)$/i;
    const bad = /^(Vista previa del feed|Feed preview|Meta Business Suite|Insights|Estad[ií]sticas|Contenido|Publicaciones|Posts|Facebook|Instagram|Martin Rodriguez|Me gusta|Comentar|Compartir|Like|Comment|Share|Ver m[aá]s|See more)$/i;
    const labels = [...document.querySelectorAll('h1, h2, h3, [role="heading"], span, div')]
      .filter(el => labelRe.test((el.textContent || '').replace(/\s+/g, ' ').trim()));

    const isCandidate = (text) => {
      const name = text.replace(/\s+/g, ' ').trim();
      return (
        name.length >= 2 &&
        name.length <= 90 &&
        !bad.test(name) &&
        !/^\d/.test(name) &&
        !/[•·]/.test(name) &&
        !/^(Crear|Exportar|Agregar|Promocionar|Impulsar|Buscar|Filtrar|Ordenar|Publicado|Published|Patrocinado|Sponsored)/i.test(name)
      );
    };

    const textPartsFrom = (el) => {
      if (!document.createTreeWalker) {
        return (el.textContent || '')
          .split(/\n+/)
          .map(line => line.replace(/\s+/g, ' ').trim())
          .filter(Boolean);
      }

      const parts = [];
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        const text = node.nodeValue.replace(/\s+/g, ' ').trim();
        if (text) parts.push(text);
      }
      return parts;
    };

    for (const label of labels) {
      let container = label.parentElement;
      for (let depth = 0; container && container !== document.body && depth < 10; depth++) {
        const lines = textPartsFrom(container);
        const labelIndex = lines.findIndex(line => labelRe.test(line));

        if (labelIndex !== -1) {
          const afterLabel = lines.slice(labelIndex + 1);
          const direct = afterLabel.find(isCandidate);
          if (direct) return direct;
        }

        container = container.parentElement;
      }
    }

    return '';
  };

  const scripts = [...document.querySelectorAll('script[type="application/json"]')];

  for (const script of scripts) {
    let data;
    try { data = JSON.parse(script.textContent); } catch (e) { continue; }

    let insights = null;
    const metrics = {};
    let entityInfo = null;
    const seen = new WeakSet();

    const walk = (obj) => {
      if (!obj || typeof obj !== 'object' || seen.has(obj)) return;
      seen.add(obj);

      mergeMetrics(metrics, obj);

      const typename = String(obj.__typename || '');
      const looksLikeInsights =
        /Insights|Metric|Video|Reel/i.test(typename) ||
        obj.views !== undefined ||
        obj.video_views !== undefined ||
        obj.reels_plays !== undefined;

      if (!insights && looksLikeInsights && (metrics.views != null || metrics.interactions != null)) {
        insights = obj;
      }

      if (!entityInfo && obj.title && (obj.image_source || obj.created_at || obj.media_type || obj.video_source)) {
        entityInfo = {
          title: obj.title,
          imageUri: obj.image_source?.uri || '',
          createdAt: obj.created_at,
          mediaType: obj.media_type || obj.content_type || obj.__typename || ''
        };
      }

      if (insights && entityInfo && metrics.views != null) return;

      for (const k of Object.keys(obj)) {
        if (insights && entityInfo && metrics.views != null) break;
        try { walk(obj[k]); } catch (e) {}
      }
    };

    try { walk(data); } catch (e) {}

    if (!insights) continue;

    // Largest rendered image on the page (feed preview)
    const imgs = [...document.querySelectorAll('img')]
      .filter(i => i.src && i.src.includes('fbcdn') && !i.src.includes('rsrc.php') && !i.src.includes('emoji.php'))
      .sort((a, b) => (b.naturalWidth * b.naturalHeight) - (a.naturalWidth * a.naturalHeight));

    return {
      pageName: extractPageNameFromFeedPreview(),
      views: metrics.views ?? insights.views?.value ?? null,
      viewers: metrics.viewers ?? insights.viewers?.value ?? null,
      interactions: metrics.interactions ?? insights.net_interaction?.value ?? null,
      content: entityInfo?.title || '',
      imageUrl: imgs[0]?.src || entityInfo?.imageUri || '',
      createdAt: entityInfo?.createdAt || null,
      mediaType: entityInfo?.mediaType || ''
    };
  }

  return null;
}

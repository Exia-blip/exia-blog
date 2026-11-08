// 结构化数据（schema.org / JSON-LD）
// 统一从这里出，避免首页、文章页各写一份、字段慢慢走偏。

import { catName } from './taxonomy.js';
import { avatarSrc } from '../public/avatar.js';

export function iso(sqlDate, fallback = '') {
  const s = String(sqlDate || '').trim();
  if (!s) return fallback;
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) return s;
  // D1 存的是 "YYYY-MM-DD HH:MM:SS"（UTC），转标准 ISO
  const d = new Date(s.replace(' ', 'T') + (s.includes('Z') ? '' : 'Z'));
  return isNaN(d) ? fallback : d.toISOString();
}

export function ldJson(obj) {
  const json = JSON.stringify(obj).replace(/</g, '\\u003c').replace(/\u2028|\u2029/g, '');
  return `<script type="application/ld+json">${json}</script>`;
}

function abs(pathOrUrl, origin) {
  if (!pathOrUrl) return '';
  try {
    return new URL(pathOrUrl, origin).toString();
  } catch {
    return '';
  }
}

/** 站点级：WebSite（带站内搜索）+ 站点主人 */
export function siteLd(site, origin) {
  const name = site.name || 'Blog';
  const graph = [
    {
      '@type': 'WebSite',
      '@id': `${origin}/#website`,
      url: `${origin}/`,
      name,
      description: site.desc || '',
      inLanguage: 'zh-CN',
      publisher: { '@id': `${origin}/#owner` },
      // 站点 logo 用本站图标，别把 GitHub 头像递出去当品牌标识
      logo: {
        '@type': 'ImageObject',
        url: `${origin}/icon-512.png`,
        width: 512,
        height: 512,
      },
      image: `${origin}/og-default.jpg`,
      potentialAction: {
        '@type': 'SearchAction',
        target: { '@type': 'EntryPoint', urlTemplate: `${origin}/?q={search_term_string}` },
        'query-input': 'required name=search_term_string',
      },
    },
    {
      '@type': 'Person',
      '@id': `${origin}/#owner`,
      name,
      description: site.desc || '',
      url: `${origin}/`,
      // 作者头像也走本站代理：JSON-LD 里递一个 githubusercontent 的外链既慢又可能被墙
      image: site.avatar ? abs(avatarSrc(site.avatar, 128), origin) : undefined,
    },
  ];
  return { '@context': 'https://schema.org', '@graph': graph };
}

/** 文章页：BlogPosting + 面包屑 */
export function postLd({ post, site, origin, url, image, words }) {
  const siteName = site.name || 'Blog';
  // 发布时间优先用 published_at（草稿转发布的时刻），没有才退回创建时间
  const pub = iso(post.published_at || post.created_at);
  const mod = iso(post.updated_at, pub);
  const images = image ? [abs(image, origin)] : undefined;
  // 栏目对外一律用中文名：slug 是内部路由用的，写进 JSON-LD 既不好看也不利于分类标注
  const catLabel = post.category ? catName(post.category) || post.category : '';

  const article = {
    '@type': 'BlogPosting',
    '@id': `${url}#article`,
    headline: String(post.title || '').slice(0, 110),
    name: post.title,
    description: post.summary || post.excerpt || '',
    url,
    mainEntityOfPage: { '@type': 'WebPage', '@id': url },
    inLanguage: 'zh-CN',
    datePublished: pub || undefined,
    dateModified: mod || undefined,
    author: {
      '@type': 'Person',
      name: post.author || siteName,
      url: `${origin}/`,
      image: abs(post.avatar, origin) || undefined,
    },
    publisher: { '@id': `${origin}/#owner` },
    image: images,
    keywords: (post.tags || []).join(','),
    articleSection: catLabel || undefined,
    wordCount: words || undefined,
    timeRequired: post.reading ? `PT${post.reading}M` : undefined,
    isAccessibleForFree: true,
    commentCount: post.comments || undefined,
    // 系列文声明所属系列，搜索引擎能把同系列的几篇串成一组
    isPartOf: post.series
      ? { '@type': 'CreativeWorkSeries', name: post.series, url: `${origin}/p/${encodeURIComponent(post.slug)}` }
      : `${origin}/#website`,
  };

  const crumbs = [
    { '@type': 'ListItem', position: 1, name: '首页', item: `${origin}/` },
    catLabel
      ? { '@type': 'ListItem', position: 2, name: catLabel, item: `${origin}/cat/${encodeURIComponent(post.category)}` }
      : null,
    {
      '@type': 'ListItem',
      position: catLabel ? 3 : 2,
      name: post.title,
      item: url,
    },
  ].filter(Boolean);

  return {
    '@context': 'https://schema.org',
    '@graph': [article, { '@type': 'BreadcrumbList', itemListElement: crumbs }],
  };
}

/** 列表页（首页 / 归档 / 栏目 / 标签）：CollectionPage + ItemList */
export function listLd({ site, origin, url, name, desc, posts }) {
  const items = (posts || []).slice(0, 20).map((p, i) => ({
    '@type': 'ListItem',
    position: i + 1,
    url: `${origin}/p/${encodeURIComponent(p.slug)}`,
    name: p.title,
  }));
  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'CollectionPage',
        '@id': url,
        url,
        name,
        description: desc || site.desc || '',
        inLanguage: 'zh-CN',
        isPartOf: { '@id': `${origin}/#website` },
      },
      items.length ? { '@type': 'ItemList', itemListElement: items } : null,
    ].filter(Boolean),
  };
}

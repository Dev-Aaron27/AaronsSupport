import { readFile, writeFile, mkdir, readdir, rm, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { commands } from '../src/catalog.js';

const repository = 'https://github.com/Dev-Aaron27/AaronsSupport';
const pages = [
  { slug: 'index', title: 'Introduction', group: 'Getting started' },
  { slug: 'choose-host', title: 'Choosing a host', group: 'Getting started' },
  { slug: 'setup', title: 'Installation', group: 'Getting started' },
  { slug: 'pterodactyl', title: 'Pterodactyl', group: 'Getting started' },
  { slug: 'usage', title: 'Usage', group: 'Using the bot' },
  { slug: 'commands', title: 'Command reference', group: 'Using the bot' },
  { slug: 'faq', title: 'Frequently asked questions', group: 'Using the bot' },
  { slug: 'configuration', title: 'Configuration', group: 'Reference' },
  { slug: 'plugins', title: 'Plugins', group: 'Reference' },
  { slug: 'oauth', title: 'Log viewer', group: 'Reference' },
  { slug: 'operations', title: 'Backups & updates', group: 'Reference' },
];
const levels = ['Members', 'Staff', 'Senior staff', 'Administrators', 'Owners'];
const searchIndex = [];
const assets = {};
for (const file of ['style.css', 'site.js', 'favicon.svg']) {
  const bytes = await readFile(`docs/${file}`);
  assets[file] = `${file}?v=${createHash('sha256').update(bytes).digest('hex').slice(0, 12)}`;
}
const esc = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const plain = value => value.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/[`*]/g, '');
const slugify = value => plain(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
function websiteLink(href) {
  if (href === '../deploy/pterodactyl/egg-aarons-support.json') return 'downloads/egg-aarons-support.json';
  if (href.startsWith('../CONTRIBUTING.md')) return `${repository}/blob/main/${href.slice(3)}`;
  if (/^[a-z-]+\.md(?:#.*)?$/.test(href)) return href.replace('.md', '.html');
  return href;
}
function inline(source) {
  return source.split(/(`[^`]+`|\[[^\]]+\]\([^)]+\)|\*\*[^*]+\*\*)/g).map(part => {
    if (part.startsWith('`') && part.endsWith('`')) return `<code>${esc(part.slice(1, -1))}</code>`;
    const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(part);
    if (link && !/^(?:javascript|data|vbscript):/i.test(link[2])) return `<a href="${esc(websiteLink(link[2]))}">${esc(link[1])}</a>`;
    if (part.startsWith('**') && part.endsWith('**')) return `<strong>${inline(part.slice(2, -2))}</strong>`;
    return esc(part);
  }).join('');
}
function heading(level, title, id) {
  const anchor = level === 1 ? '' : `<a class="heading-anchor" href="#${esc(id)}" aria-label="Link to ${esc(plain(title))}">#</a>`;
  return `<h${level} id="${esc(id)}">${inline(title)}${anchor}</h${level}>`;
}
function codeBlock(text, language = '') {
  return `<div class="code-block"><div class="code-toolbar"><span>${esc(language || 'text')}</span><button class="copy-code" type="button" aria-label="Copy code">Copy</button></div><pre><code>${esc(text)}</code></pre></div>`;
}
function markdown(source, page) {
  const lines = source.split('\n'), output = [], headings = [], ids = new Map();
  let section = { title: page.title, url: `${page.slug}.html`, text: [] };
  function flushSection() {
    searchIndex.push({ title: section.title, page: page.title, url: section.url, text: plain(section.text.join(' ')) });
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    if (line.startsWith('```')) {
      const code = [], language = line.slice(3).trim();
      while (++i < lines.length && !lines[i].startsWith('```')) code.push(lines[i]);
      output.push(codeBlock(code.join('\n'), language));
      section.text.push(code.join(' '));
      continue;
    }
    const match = /^(#{1,3}) (.*)$/.exec(line);
    if (match) {
      const level = match[1].length, title = match[2], base = slugify(title);
      const occurrence = (ids.get(base) || 0) + 1;
      ids.set(base, occurrence);
      const id = occurrence === 1 ? base : `${base}-${occurrence}`;
      output.push(heading(level, title, id));
      if (level > 1) {
        headings.push({ level, title: plain(title), id });
        flushSection();
        section = { title: plain(title), url: `${page.slug}.html#${id}`, text: [] };
      }
      continue;
    }
    if (line.startsWith('|') && lines[i + 1]?.includes('---')) {
      const cells = row => row.split('|').slice(1, -1).map(value => value.trim());
      const heads = cells(line), rows = [];
      i++;
      while (lines[i + 1]?.startsWith('|')) rows.push(cells(lines[++i]));
      output.push(`<div class="table-wrap"><table><thead><tr>${heads.map(h => `<th scope="col">${inline(h)}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${row.map(c => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
      section.text.push(...heads, ...rows.flat());
      continue;
    }
    if (/^(- |\d+\. )/.test(line)) {
      const ordered = /^\d/.test(line), tag = ordered ? 'ol' : 'ul';
      const items = [line.replace(/^(- |\d+\. )/, '')];
      while (/^(- |\d+\. )/.test(lines[i + 1] || '')) items.push(lines[++i].replace(/^(- |\d+\. )/, ''));
      output.push(`<${tag}>${items.map(item => `<li>${inline(item)}</li>`).join('')}</${tag}>`);
      section.text.push(...items);
      continue;
    }
    const paragraph = [line];
    while (lines[i + 1]?.trim() && !/^(#|```|- |\d+\. |\|)/.test(lines[i + 1])) paragraph.push(lines[++i]);
    output.push(`<p>${inline(paragraph.join(' '))}</p>`);
    section.text.push(...paragraph);
  }
  flushSection();
  return { body: output.join('\n'), headings };
}
function commandPage(page) {
  searchIndex.push({ title: page.title, page: page.title, url: 'commands.html', text: 'All 66 bot commands, usage and permission levels.' });
  const headings = [], sections = [];
  for (let level = 1; level <= 5; level++) {
    const title = `Level ${level} · ${levels[level - 1]}`, id = `level-${level}`;
    headings.push({ level: 2, title, id });
    const entries = Object.values(commands).filter(command => command.level === level);
    sections.push(`<section class="command-section" data-command-group>${heading(2, title, id)}${entries.map(command => {
      const usage = `.${command.name}${command.usage ? ` ${command.usage}` : ''}`;
      searchIndex.push({ title: `.${command.name}`, page: page.title, url: `commands.html#${command.name}`, text: `${command.description} ${usage} level ${level} ${levels[level - 1]}` });
      return `<section class="command" id="${command.name}" data-level="${level}" data-search="${esc(`${command.name} ${command.description} level ${level} ${levels[level - 1]}`)}"><div class="command-heading"><h3><code>.${command.name}</code><a class="heading-anchor" href="#${command.name}" aria-label="Link to .${command.name}">#</a></h3><span class="command-level">Level ${level}</span></div><p>${esc(command.description)}</p>${codeBlock(usage, 'text')}</section>`;
    }).join('')}</section>`);
  }
  const body = `${heading(1, page.title, 'command-reference')}<p>Use <code>.help command</code> in Discord to check a command’s usage and your access. These are the default permission levels; owners can raise command requirements.</p><p>The prefix shown is <code>.</code>. Replace it with your server’s prefix. Required arguments use <code>&lt;angle brackets&gt;</code>; optional arguments use <code>[square brackets]</code>.</p><div class="command-filters"><div><label for="command-search">Find a command</label><input id="command-search" type="search" placeholder="Name or action…"></div><div><label for="level-filter">Permission level</label><select id="level-filter"><option value="">All levels</option>${levels.map((label, i) => `<option value="${i + 1}">${i + 1} · ${label}</option>`).join('')}</select></div></div><p id="search-count" role="status" aria-live="polite"></p><div class="command-grid">${sections.join('')}</div><p id="command-empty" hidden>No commands found. Try another term or permission level.</p>`;
  return { body, headings };
}
const icon = (name, extra = '') => {
  const paths = {
    mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 6 9 7 9-7"/>',
    search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4.5 4.5"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/>',
    menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
    arrow: '<path d="m9 5 7 7-7 7"/>',
  };
  return `<svg ${extra} width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name]}</svg>`;
};
function navigation(current) {
  return `<nav aria-label="Documentation">${[...new Set(pages.map(p => p.group))].map(group => `<div class="nav-group"><p class="nav-label">${group}</p>${pages.filter(p => p.group === group).map(p => `<a href="${p.slug}.html"${p.slug === current ? ' aria-current="page"' : ''}>${esc(p.title)}</a>`).join('')}</div>`).join('')}</nav>`;
}
function contents(headings) {
  return `<nav class="toc-links" aria-label="On this page">${headings.map(h => `<a href="#${esc(h.id)}"${h.level === 3 ? ' class="toc-subheading"' : ''}>${esc(h.title)}</a>`).join('')}</nav>`;
}
await mkdir('_site', { recursive: true });
for (const entry of await readdir('_site')) await rm(`_site/${entry}`, { recursive: true, force: true });
for (const [position, page] of pages.entries()) {
  const { body, headings } = page.slug === 'commands' ? commandPage(page) : markdown(await readFile(`docs/${page.slug}.md`, 'utf8'), page);
  const previous = pages[position - 1], next = pages[position + 1];
  const pageLink = (target, direction) => target ? `<a class="page-link ${direction}" href="${target.slug}.html"><span>${direction === 'previous' ? 'Previous' : 'Next'}</span><strong>${esc(target.title)}</strong>${icon('arrow')}</a>` : '<div></div>';
  const editPath = page.slug === 'commands' ? 'src/catalog.js' : `docs/${page.slug}.md`;
  await writeFile(`_site/${page.slug}.html`, `<!doctype html>
<html lang="en" data-theme="light">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="description" content="${esc(page.title)} — Aaron’s Support Discord modmail documentation"><meta name="color-scheme" content="light dark"><title>${esc(page.title)} | Aaron’s Support Docs</title><script>try{const theme=localStorage.getItem('docs-theme');if(theme==='dark'||theme==='light')document.documentElement.dataset.theme=theme;}catch{}</script><link rel="icon" href="${assets['favicon.svg']}" type="image/svg+xml"><link rel="stylesheet" href="${assets['style.css']}"><script src="${assets['site.js']}" defer></script></head>
<body>
<a class="skip-link" href="#main">Skip to content</a>
<header class="site-header"><div class="header-inner"><a class="brand" href="index.html"><span class="brand-icon">${icon('mail')}</span>Aaron’s Support <span class="brand-docs">Docs</span></a><div class="header-actions"><a class="header-link" href="setup.html">Installation</a><a class="header-link" href="${repository}">GitHub ↗</a><button class="search-trigger" type="button" data-search-open aria-label="Search documentation" aria-haspopup="dialog">${icon('search')}<span>Search docs…</span><kbd><span data-modifier>Ctrl</span> K</kbd></button><button class="theme-toggle" type="button" aria-label="Switch to dark theme" title="Switch to dark theme">${icon('sun')}</button></div></div></header>
<div class="docs-layout"><aside class="sidebar">${navigation(page.slug)}<a class="sidebar-source" href="${repository}">Aaron’s Support · v2.0</a></aside>
<main id="main"><details class="mobile-navigation"><summary>${icon('menu')} Documentation</summary>${navigation(page.slug)}</details><div class="breadcrumb">${esc(page.group)}</div><details class="mobile-toc"><summary>On this page</summary>${contents(headings)}</details><article class="document">${body}</article><nav class="page-navigation" aria-label="Previous and next pages">${pageLink(previous, 'previous')}${pageLink(next, 'next')}</nav><footer class="page-footer"><a href="${repository}/edit/main/${editPath}">Edit this page on GitHub ↗</a><span>Aaron’s Support documentation</span></footer></main>
<aside class="page-toc"><p class="toc-title">On this page</p>${contents(headings)}</aside></div>
<dialog id="docs-search" aria-labelledby="docs-search-title"><div class="search-dialog-heading"><h2 id="docs-search-title">Search documentation</h2><button type="button" data-search-close aria-label="Close search">Esc</button></div><label class="sr-only" for="docs-search-input">Search pages and commands</label><div class="search-input-wrap">${icon('search')}<input id="docs-search-input" type="search" placeholder="Search pages and commands…" autocomplete="off"></div><p id="docs-search-status" role="status" aria-live="polite">Type to search the guides and command reference.</p><div id="docs-search-results"></div><div class="search-dialog-footer"><span>↑ ↓ Navigate</span><span>↵ Open</span><span>Esc Close</span></div></dialog>
</body></html>\n`);
}
for (const file of ['style.css', 'site.js', 'favicon.svg']) await copyFile(`docs/${file}`, `_site/${file}`);
await writeFile('_site/search-index.json', `${JSON.stringify(searchIndex)}\n`);
await mkdir('_site/downloads', { recursive: true });
await copyFile('deploy/pterodactyl/egg-aarons-support.json', '_site/downloads/egg-aarons-support.json');
await writeFile('_site/.nojekyll', '');
console.log(`Built ${pages.length} pages, ${Object.keys(commands).length} commands, and ${searchIndex.length} searchable sections into _site.`);

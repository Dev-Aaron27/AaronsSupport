const themeButton = document.querySelector('.theme-toggle');
function updateThemeButton() {
  const label = `Switch to ${document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'} theme`;
  themeButton.setAttribute('aria-label', label);
  themeButton.title = label;
}
updateThemeButton();
themeButton.addEventListener('click', () => {
  const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem('docs-theme', theme); } catch { /* Theme still works without storage. */ }
  updateThemeButton();
});

for (const button of document.querySelectorAll('.copy-code')) {
  button.addEventListener('click', async () => {
    const code = button.closest('.code-block').querySelector('pre code').textContent;
    try {
      await navigator.clipboard.writeText(code);
      button.textContent = 'Copied';
      button.setAttribute('aria-label', 'Code copied');
    } catch {
      button.textContent = 'Select to copy';
      const selection = window.getSelection(), range = document.createRange();
      range.selectNodeContents(button.closest('.code-block').querySelector('pre code'));
      selection.removeAllRanges();
      selection.addRange(range);
    }
    setTimeout(() => { button.textContent = 'Copy'; button.setAttribute('aria-label', 'Copy code'); }, 2000);
  });
}

const dialog = document.querySelector('#docs-search');
const searchInput = document.querySelector('#docs-search-input');
const searchStatus = document.querySelector('#docs-search-status');
const searchResults = document.querySelector('#docs-search-results');
let indexPromise, entries;
const normalize = value => value.toLocaleLowerCase().trim();
function renderResults() {
  if (!entries) return;
  const query = normalize(searchInput.value), terms = query.split(/\s+/).filter(Boolean);
  const results = entries.map(entry => {
    const title = normalize(entry.title), text = normalize(`${entry.title} ${entry.page} ${entry.text}`);
    const matches = terms.every(term => text.includes(term));
    const score = title === query ? 100 : title.includes(query) ? 50 : terms.filter(term => title.includes(term)).length * 10;
    return { entry, matches, score };
  }).filter(result => query ? result.matches : !result.entry.url.includes('#'))
    .sort((a, b) => b.score - a.score);
  searchResults.replaceChildren();
  for (const { entry } of results.slice(0, 12)) {
    const link = document.createElement('a');
    link.href = entry.url;
    link.className = 'search-result';
    const page = document.createElement('span');
    page.textContent = entry.page;
    const title = document.createElement('strong');
    title.textContent = entry.title;
    const excerpt = document.createElement('p');
    const firstMatch = terms.length ? normalize(entry.text).indexOf(terms[0]) : 0;
    const start = Math.max(0, firstMatch - 35);
    const text = entry.text.slice(start, start + 150);
    excerpt.textContent = `${start ? '…' : ''}${text}${entry.text.length > start + 150 ? '…' : ''}`;
    link.append(page, title, excerpt);
    link.addEventListener('click', () => {
      dialog.close();
      // A link to the current hash does not emit hashchange. Reveal filtered commands too.
      if (link.pathname === location.pathname && link.hash) {
        const filter = document.querySelector('#command-search');
        if (filter) {
          filter.value = '';
          document.querySelector('#level-filter').value = '';
          filter.dispatchEvent(new Event('input'));
        }
        requestAnimationFrame(() => document.getElementById(link.hash.slice(1))?.scrollIntoView());
      }
    });
    searchResults.append(link);
  }
  searchStatus.textContent = results.length
    ? `${query ? `${results.length} results` : 'Browse the documentation'}${results.length > 12 ? ' · showing the first 12' : ''}`
    : 'No results. Try a command name or a shorter search.';
}
async function openSearch() {
  if (dialog.open) return;
  dialog.showModal();
  searchInput.focus();
  searchInput.select();
  searchStatus.textContent = 'Loading documentation…';
  try {
    indexPromise ||= fetch('search-index.json', { cache: 'no-store' }).then(response => {
      if (!response.ok) throw new Error('Search index unavailable');
      return response.json();
    });
    entries = await indexPromise;
    renderResults();
  } catch {
    indexPromise = null;
    searchStatus.textContent = 'Search could not load. Use the sidebar to browse, or close search and try again.';
  }
}
for (const button of document.querySelectorAll('[data-search-open]')) button.addEventListener('click', openSearch);
document.querySelector('[data-search-close]').addEventListener('click', () => dialog.close());
searchInput.addEventListener('input', renderResults);
dialog.addEventListener('click', event => {
  const rect = dialog.getBoundingClientRect();
  if (event.target === dialog && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom)) dialog.close();
});
dialog.addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    event.preventDefault();
    dialog.close();
    return;
  }
  const links = [...searchResults.querySelectorAll('a')];
  const active = links.indexOf(document.activeElement);
  if (['ArrowDown', 'ArrowUp'].includes(event.key) && links.length) {
    event.preventDefault();
    const next = event.key === 'ArrowDown' ? Math.min(active + 1, links.length - 1) : active <= 0 ? links.length - 1 : active - 1;
    links[next].focus();
  }
  if (event.key === 'Enter' && document.activeElement === searchInput && links.length) {
    event.preventDefault();
    links[0].click();
  }
});
const modifier = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl';
document.querySelector('[data-modifier]').textContent = modifier;
document.addEventListener('keydown', event => {
  const typing = event.target.closest('input, textarea, select, [contenteditable="true"]');
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    if (dialog.open) dialog.close(); else openSearch();
  } else if (event.key === '/' && !typing && !dialog.open) {
    event.preventDefault();
    openSearch();
  }
});

const commandInput = document.querySelector('#command-search');
if (commandInput) {
  const levelInput = document.querySelector('#level-filter');
  const cards = [...document.querySelectorAll('.command')];
  function filterCommands() {
    const terms = normalize(commandInput.value).split(/\s+/).filter(Boolean);
    let visible = 0;
    for (const card of cards) {
      card.hidden = !(terms.every(term => normalize(card.dataset.search).includes(term)) && (!levelInput.value || card.dataset.level === levelInput.value));
      if (!card.hidden) visible++;
    }
    for (const group of document.querySelectorAll('[data-command-group]')) group.hidden = !group.querySelector('.command:not([hidden])');
    document.querySelector('#search-count').textContent = `${visible} of ${cards.length} commands`;
    document.querySelector('#command-empty').hidden = visible !== 0;
  }
  commandInput.addEventListener('input', filterCommands);
  levelInput.addEventListener('change', filterCommands);
  filterCommands();
  function revealHashTarget() {
    const target = document.getElementById(location.hash.slice(1));
    if (target?.closest('.command-grid')) {
      commandInput.value = '';
      levelInput.value = '';
      filterCommands();
      requestAnimationFrame(() => target.scrollIntoView());
    }
  }
  window.addEventListener('hashchange', revealHashTarget);
  for (const link of document.querySelectorAll('.toc-links a')) link.addEventListener('click', () => {
    commandInput.value = ''; levelInput.value = ''; filterCommands();
  });
  revealHashTarget();
}

const tocTargets = new Set([...document.querySelectorAll('.toc-links a')].map(link => link.hash.slice(1)));
const headings = [...document.querySelectorAll('.document h2[id], .document h3[id]')].filter(heading => tocTargets.has(heading.id));
function updateContents() {
  const visible = headings.filter(heading => !heading.closest('[hidden]'));
  const current = visible.filter(heading => heading.getBoundingClientRect().top <= 120).at(-1) || visible[0];
  for (const link of document.querySelectorAll('.toc-links a')) {
    if (current && link.hash === `#${current.id}`) link.setAttribute('aria-current', 'location');
    else link.removeAttribute('aria-current');
  }
}
let scrollQueued = false;
window.addEventListener('scroll', () => {
  if (!scrollQueued) {
    scrollQueued = true;
    requestAnimationFrame(() => { updateContents(); scrollQueued = false; });
  }
}, { passive: true });
updateContents();

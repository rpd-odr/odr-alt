const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(ROOT, 'sources.json');
const OUTPUT_PATH = path.join(ROOT, 'repo', 'source.json');
const BACKUP_PATH = path.join(ROOT, 'repo', '.last_good.json');
const REQUEST_TIMEOUT_MS = 20000;
const RETRIES = 3;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const readJSON = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const writeJSON = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
};

async function fetchJSON(url, attempt = 1) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'application/json, application/vnd.github+json',
        'User-Agent': 'rpd-odr/odr-alt-generator',
        'X-GitHub-Api-Version': '2022-11-28'
      }
    });
    if (response.ok) return await response.json();

    const retryable = response.status === 429 || response.status === 403 || response.status >= 500;
    if (retryable && attempt < RETRIES) {
      const retryAfter = Number(response.headers.get('retry-after'));
      const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1500 * 2 ** (attempt - 1);
      await sleep(delay);
      return fetchJSON(url, attempt + 1);
    }
    throw new Error(`HTTP ${response.status}`);
  } finally {
    clearTimeout(timer);
  }
}

function matchesTag(raw, app) {
  if (!app.versionTagFilter) return true;
  const tag = String(raw.tag_name || raw.version || raw.latestVersion || '').trim();
  const filters = Array.isArray(app.versionTagFilter) ? app.versionTagFilter : [app.versionTagFilter];
  return filters.some(filter => {
    if (typeof filter !== 'string') return false;
    if (filter.startsWith('regex:')) {
      try { return new RegExp(filter.slice(6), 'i').test(tag); } catch { return false; }
    }
    return tag === filter || tag.replace(/^v/i, '') === filter.replace(/^v/i, '');
  });
}

function matchesName(item, app) {
  if (!app.matchName) return true;
  return item?.name === app.matchName || item?.displayName === app.matchName;
}

function normalizeApp(raw, config) {
  if (!raw || typeof raw !== 'object' || !raw.downloadURL) return null;
  const version = String(raw.version || raw.latestVersion || '0.0');
  const date = raw.versionDate || raw.date || new Date().toISOString();
  return {
    name: config.name,
    bundleIdentifier: raw.bundleIdentifier || config.bundleIdentifier,
    developerName: config.developerName || raw.developerName || 'GitHub Community',
    subtitle: config.subtitle || raw.subtitle || '',
    iconURL: config.iconURL || raw.iconURL,
    tintColor: config.tintColor || raw.tintColor,
    version,
    versionDate: date,
    versionDescription: config.localizedDescription || raw.versionDescription || raw.localizedDescription || raw.description || '',
    downloadURL: raw.downloadURL,
    size: Number(raw.size) || 0
  };
}

async function processExternal(app) {
  console.log(`🌐 ${app.name}: ${app.sourceURL}`);
  const data = await fetchJSON(app.sourceURL);
  const list = Array.isArray(data) ? data : Array.isArray(data?.apps) ? data.apps : [];
  const normalized = list
    .filter(item => matchesName(item, app))
    .filter(item => matchesTag(item, app))
    .map(x => normalizeApp(x, app))
    .filter(Boolean);
  if (!normalized.length) throw new Error(`приложение/версия ${app.matchName || app.bundleIdentifier} не найдено в источнике`);
  return normalized.sort((a, b) => new Date(b.versionDate) - new Date(a.versionDate)).slice(0, Math.max(1, Number(app.versionsLimit) || 5));
}

async function processGitHub(app) {
  console.log(`📦 ${app.name}: ${app.repo}`);
  const releases = [];
  for (let page = 1; page <= 5; page++) {
    const data = await fetchJSON(`https://api.github.com/repos/${app.repo}/releases?per_page=100&page=${page}`);
    if (!Array.isArray(data) || !data.length) break;
    releases.push(...data);
    if (data.length < 100) break;
  }

  const candidates = releases.flatMap(release => {
    if (release.draft || (app.stableOnly && release.prerelease)) return [];
    if (!matchesTag(release, app)) return [];
    const assets = (release.assets || []).filter(a => /\.ipa(?:\.zip)?$/i.test(a.name || ''));
    if (!assets.length) return [];
    const asset = assets.sort((a, b) => (b.size || 0) - (a.size || 0))[0];
    const version = String(release.tag_name || release.name || '').replace(/^v/i, '').trim();
    if (!version) return [];
    return [{
      name: app.name,
      bundleIdentifier: app.bundleIdentifier,
      developerName: app.developerName || 'GitHub Community',
      subtitle: app.subtitle || '',
      iconURL: app.iconURL,
      tintColor: app.tintColor,
      version,
      versionDate: release.published_at || release.created_at,
      versionDescription: app.localizedDescription || release.body || '',
      downloadURL: asset.browser_download_url,
      size: asset.size || 0
    }];
  });

  const seen = new Set();
  return candidates
    .sort((a, b) => new Date(b.versionDate) - new Date(a.versionDate))
    .filter(x => !seen.has(x.version) && seen.add(x.version))
    .slice(0, Math.max(1, Number(app.versionsLimit) || 5));
}

function toAltStore(apps) {
  const latest = apps[0];
  return {
    name: latest.name,
    bundleIdentifier: latest.bundleIdentifier,
    developerName: latest.developerName,
    subtitle: latest.subtitle,
    version: latest.version,
    versionDate: latest.versionDate,
    versionDescription: latest.versionDescription.slice(0, 500),
    downloadURL: latest.downloadURL,
    iconURL: latest.iconURL,
    ...(latest.tintColor ? { tintColor: latest.tintColor } : {}),
    size: latest.size,
    versions: apps.map(v => ({
      version: v.version,
      date: v.versionDate,
      downloadURL: v.downloadURL,
      size: v.size,
      localizedDescription: v.versionDescription
    }))
  };
}

async function main() {
  console.log('🚀 AltStore generator started');
  const config = readJSON(CONFIG_PATH);
  if (!config.name || !config.identifier || !config.sourceURL || !Array.isArray(config.apps) || !config.apps.length) throw new Error('Некорректный sources.json');

  let lastGood = null;
  try { lastGood = readJSON(BACKUP_PATH); } catch {}

  const generatedApps = [];
  for (const app of config.apps) {
    try {
      const versions = app.sourceURL ? await processExternal(app) : await processGitHub(app);
      if (!versions.length) throw new Error('не найдено ни одной версии с downloadURL');
      generatedApps.push({ app, versions });
      console.log(`  ✅ ${app.name}: ${versions.length} версий`);
    } catch (error) {
      console.error(`  ❌ ${app.name}: ${error.message}`);
      const previous = lastGood?.apps?.find(x => x.name === app.name);
      if (previous?.versions?.length) {
        console.warn(`  ↩ ${app.name}: использую last good`);
        generatedApps.push({
          app,
          versions: previous.versions.map(v => ({
            name: app.name,
            bundleIdentifier: previous.bundleIdentifier,
            developerName: app.developerName || previous.developerName,
            subtitle: app.subtitle || previous.subtitle,
            iconURL: app.iconURL || previous.iconURL,
            tintColor: app.tintColor || previous.tintColor,
            version: v.version,
            versionDate: v.date,
            versionDescription: app.localizedDescription || v.localizedDescription || '',
            downloadURL: v.downloadURL,
            size: v.size || 0
          }))
        });
      }
    }
  }

  if (!generatedApps.length) throw new Error('Не удалось получить приложения и нет last good');

  // One sources.json entry = one AltStore app. Do NOT group by bundleIdentifier:
  // AltStore can contain multiple selectable mods sharing the same bundle ID.
  const apps = generatedApps.map(x => toAltStore(x.versions));
  const source = {
    name: config.name,
    identifier: config.identifier,
    sourceURL: config.sourceURL,
    apps,
    news: apps.map(app => ({
      title: `${app.name} ${app.version}`,
      identifier: app.bundleIdentifier,
      caption: app.versionDescription || '',
      date: app.versionDate,
      link: app.downloadURL,
      notify: true
    }))
  };

  writeJSON(OUTPUT_PATH, source);
  writeJSON(BACKUP_PATH, source);
  console.log(`🎉 Готово: ${apps.length} отдельных apps-записей с downloadURL`);
}

main().catch(error => {
  console.error(`💥 ${error.message}`);
  process.exit(1);
});

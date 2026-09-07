const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(ROOT, 'sources.json');
const OUTPUT_PATH = path.join(ROOT, 'repo', 'source.json');
const BACKUP_PATH = path.join(ROOT, 'repo', '.last_good.json');
const REQUEST_TIMEOUT_MS = 20000;
const RETRIES = 3;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
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

function asArray(data) {
  if (Array.isArray(data)) return data;
  for (const key of ['apps', 'plugins', 'data']) {
    if (Array.isArray(data?.[key])) return data[key];
  }
  return [];
}

function matchesName(item, config) {
  if (!config.matchName) return true;
  if (config.matchNameRegex) {
    try { return new RegExp(config.matchNameRegex, 'i').test(item?.name || ''); } catch {}
  }
  return item?.name === config.matchName || item?.displayName === config.matchName;
}

function toDate(value) {
  const time = Date.parse(value || '');
  return Number.isFinite(time) ? time : 0;
}

function latestVersion(app) {
  if (!Array.isArray(app?.versions) || !app.versions.length) return app;
  return [...app.versions].sort((a, b) => toDate(b.date || b.versionDate) - toDate(a.date || a.versionDate))[0];
}

function normalizeExternal(app, version, config) {
  const merged = { ...app, ...version };
  if (!merged.downloadURL) return null;
  return {
    name: config.outputName || app.name || config.name,
    bundleIdentifier: config.bundleIdentifier || app.bundleIdentifier,
    developerName: config.developerName || app.developerName || 'Community',
    subtitle: config.subtitle || app.subtitle || '',
    localizedDescription: config.localizedDescription || version.localizedDescription || app.localizedDescription || app.description || '',
    iconURL: config.iconURL || app.iconURL,
    tintColor: config.tintColor || app.tintColor,
    version: String(version.version || app.version || '0.0.0'),
    versionDate: version.date || version.versionDate || app.versionDate || new Date().toISOString(),
    downloadURL: version.downloadURL,
    size: Number(version.size || app.size) || 0,
    minimumOSVersion: version.minOSVersion || version.minimumOSVersion || app.minOSVersion || app.minimumOSVersion
  };
}

async function processExternal(config) {
  console.log(`🌐 ${config.name}: ${config.sourceURL}`);
  const data = await fetchJSON(config.sourceURL);
  const candidates = asArray(data).filter(item => matchesName(item, config));
  if (!candidates.length) throw new Error(`приложение ${config.matchName || config.name} не найдено`);

  const apps = [];
  for (const app of candidates) {
    const version = latestVersion(app);
    const normalized = normalizeExternal(app, version, config);
    if (normalized) apps.push(normalized);
  }
  if (!apps.length) throw new Error('не найдено ни одной записи с downloadURL');
  apps.sort((a, b) => toDate(b.versionDate) - toDate(a.versionDate));
  return apps[0];
}

async function processGitHub(config) {
  console.log(`📦 ${config.name}: ${config.repo}`);
  const release = await fetchJSON(`https://api.github.com/repos/${config.repo}/releases/latest`);
  if (release.draft || release.prerelease) throw new Error('latest release is draft/prerelease');

  let assets = (release.assets || []).filter(asset => /\.ipa(?:\.zip)?$/i.test(asset.name || ''));
  if (config.assetRegex) {
    const regex = new RegExp(config.assetRegex, 'i');
    assets = assets.filter(asset => regex.test(asset.name || ''));
  }
  if (!assets.length) throw new Error('в latest release нет IPA');

  const asset = assets.sort((a, b) => (b.size || 0) - (a.size || 0))[0];
  return {
    name: config.name,
    bundleIdentifier: config.bundleIdentifier,
    developerName: config.developerName || 'GitHub Community',
    subtitle: config.subtitle || '',
    localizedDescription: config.localizedDescription || release.body || '',
    iconURL: config.iconURL,
    tintColor: config.tintColor,
    version: String(release.tag_name || release.name || '').replace(/^v/i, '').trim(),
    versionDate: release.published_at || release.created_at,
    downloadURL: asset.browser_download_url,
    size: asset.size || 0
  };
}

function toAltStoreApp(app) {
  const result = {
    name: app.name,
    bundleIdentifier: app.bundleIdentifier,
    developerName: app.developerName,
    subtitle: app.subtitle,
    version: app.version,
    versionDate: app.versionDate,
    versionDescription: String(app.localizedDescription || '').slice(0, 5000),
    downloadURL: app.downloadURL,
    iconURL: app.iconURL,
    size: app.size,
    versions: [{
      version: app.version,
      date: app.versionDate,
      downloadURL: app.downloadURL,
      size: app.size,
      localizedDescription: app.localizedDescription || ''
    }]
  };
  if (app.tintColor) result.tintColor = app.tintColor;
  if (app.minimumOSVersion) result.minimumOSVersion = app.minimumOSVersion;
  return result;
}

async function main() {
  console.log('🚀 ODR AltStore source rebuild started');
  const config = readJSON(CONFIG_PATH);
  if (!config.name || !config.identifier || !config.sourceURL || !Array.isArray(config.apps)) throw new Error('Некорректный sources.json');

  let lastGood = null;
  try { lastGood = readJSON(BACKUP_PATH); } catch {}

  const apps = [];
  for (const entry of config.apps) {
    try {
      const current = entry.repo ? await processGitHub(entry) : await processExternal(entry);
      apps.push(toAltStoreApp(current));
      console.log(`  ✅ ${entry.name}: ${current.version}`);
    } catch (error) {
      console.error(`  ❌ ${entry.name}: ${error.message}`);
      const previous = lastGood?.apps?.find(app => app.name === (entry.outputName || entry.name));
      if (previous?.downloadURL) {
        console.warn(`  ↩ ${entry.name}: last good ${previous.version}`);
        apps.push(previous);
      }
    }
  }

  if (!apps.length) throw new Error('Не удалось собрать ни одного приложения');

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
  console.log(`🎉 Готово: ${apps.length} приложений`);
}

main().catch(error => {
  console.error(`💥 ${error.message}`);
  process.exit(1);
});

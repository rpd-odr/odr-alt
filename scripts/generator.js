const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(ROOT, 'sources.json');
const OUTPUT_PATH = path.join(ROOT, 'repo', 'source.json');
const BACKUP_PATH = path.join(ROOT, 'repo', '.last_good.json');

const USER_AGENT = 'rpd-odr/odr-alt-generator';
const API_BASE = 'https://api.github.com';
const MAX_PAGES = 5;
const REQUEST_TIMEOUT_MS = 15000;
const RETRIES = 3;
const RETRY_BASE_MS = 1500;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function readJSON(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJSON(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

function isIPA(asset) {
  return typeof asset?.name === 'string' && /\.ipa(?:\.zip)?$/i.test(asset.name);
}

function versionOf(release) {
  return String(release.tag_name || release.name || '').replace(/^v/i, '').trim();
}

async function githubFetch(url, attempt = 1) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': USER_AGENT,
        'X-GitHub-Api-Version': '2022-11-28'
      }
    });

    if (response.ok) return await response.json();

    const retryable = response.status === 429 || response.status === 403 || response.status >= 500;
    if (retryable && attempt < RETRIES) {
      const retryAfter = Number(response.headers.get('retry-after'));
      const delay = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : RETRY_BASE_MS * 2 ** (attempt - 1);
      console.warn(`  ↻ GitHub ${response.status}, повтор через ${Math.ceil(delay / 1000)}с`);
      await sleep(delay);
      return githubFetch(url, attempt + 1);
    }

    let details = '';
    try {
      const body = await response.json();
      details = body?.message ? `: ${body.message}` : '';
    } catch {}
    throw new Error(`GitHub API ${response.status}${details}`);
  } finally {
    clearTimeout(timer);
  }
}

async function fetchAllReleases(repo) {
  const releases = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = `${API_BASE}/repos/${encodeURIComponent(repo)}/releases?per_page=100&page=${page}`;
    const batch = await githubFetch(url);
    if (!Array.isArray(batch) || batch.length === 0) break;
    releases.push(...batch);
    if (batch.length < 100) break;
    await sleep(250);
  }
  return releases;
}

function chooseIPA(release) {
  const assets = (release.assets || []).filter(isIPA);
  if (!assets.length) return null;
  return assets.sort((a, b) => (b.size || 0) - (a.size || 0))[0];
}

function normalizeRelease(release, asset) {
  return {
    version: versionOf(release),
    date: release.published_at || release.created_at,
    downloadURL: asset.browser_download_url,
    size: asset.size,
    releaseNotes: release.body || ''
  };
}

async function processApp(app) {
  console.log(`📦 ${app.name} (${app.repo})`);
  const releases = await fetchAllReleases(app.repo);

  const candidates = releases
    .filter(r => !r.draft)
    .filter(r => !app.stableOnly || !r.prerelease)
    .map(r => ({ release: r, asset: chooseIPA(r) }))
    .filter(x => x.asset)
    .map(x => normalizeRelease(x.release, x.asset))
    .filter(v => v.version && v.downloadURL && v.date)
    .sort((a, b) => new Date(b.date) - new Date(a.date));

  const unique = [];
  const seen = new Set();
  for (const version of candidates) {
    if (seen.has(version.version)) continue;
    seen.add(version.version);
    unique.push(version);
  }

  const versions = unique.slice(0, Math.max(1, Number(app.versionsLimit) || 5));
  if (!versions.length) throw new Error('релизов с IPA не найдено');

  return {
    name: app.name,
    bundleIdentifier: app.bundleIdentifier,
    developerName: app.developerName || 'GitHub Community',
    subtitle: app.subtitle || `Latest GitHub release`,
    iconURL: app.iconURL,
    versions
  };
}

function appToAltStore(app) {
  const versions = [...app.versions].sort((a, b) => new Date(b.date) - new Date(a.date));
  const latest = versions[0];

  return {
    name: app.name,
    bundleIdentifier: app.bundleIdentifier,
    developerName: app.developerName,
    subtitle: app.subtitle,
    version: latest.version,
    versionDate: latest.date,
    versionDescription: latest.releaseNotes.slice(0, 200),
    downloadURL: latest.downloadURL,
    iconURL: app.iconURL,
    size: latest.size,
    versions: versions.map(v => ({
      version: v.version,
      date: v.date,
      downloadURL: v.downloadURL,
      size: v.size,
      localizedDescription: v.releaseNotes
    }))
  };
}

function buildSource(config, apps) {
  const normalized = apps.map(appToAltStore);
  return {
    name: config.name,
    identifier: config.identifier,
    sourceURL: config.sourceURL,
    apps: normalized,
    news: normalized.slice(0, 5).map(app => ({
      title: `${app.name} ${app.version}`,
      identifier: app.bundleIdentifier,
      caption: app.versionDescription || '',
      date: app.versionDate,
      link: app.downloadURL,
      notify: true
    }))
  };
}

function validateConfig(config) {
  if (!config?.name || !config?.identifier || !config?.sourceURL) {
    throw new Error('sources.json: нужны name, identifier и sourceURL');
  }
  if (!Array.isArray(config.apps) || config.apps.length === 0) {
    throw new Error('sources.json: apps должен быть непустым массивом');
  }
  for (const [i, app] of config.apps.entries()) {
    for (const field of ['name', 'repo', 'bundleIdentifier', 'iconURL']) {
      if (!app[field]) throw new Error(`sources.json: apps[${i}].${field} отсутствует`);
    }
    if (!/^[^/]+\/[^/]+$/.test(app.repo)) {
      throw new Error(`sources.json: некорректный repo у ${app.name}`);
    }
  }
}

async function main() {
  console.log('🚀 AltStore generator started');
  const config = readJSON(CONFIG_PATH);
  validateConfig(config);

  let lastGood = null;
  try { lastGood = readJSON(BACKUP_PATH); } catch {}

  const apps = [];
  const failures = [];

  for (const appConfig of config.apps) {
    try {
      apps.push(await processApp(appConfig));
    } catch (error) {
      failures.push(`${appConfig.name}: ${error.message}`);
      console.error(`  ❌ ${appConfig.name}: ${error.message}`);

      const previous = lastGood?.apps?.find(a => a.bundleIdentifier === appConfig.bundleIdentifier);
      if (previous?.versions?.length) {
        console.warn(`  ↩ Использую предыдущие версии для ${appConfig.name}`);
        apps.push({
          name: appConfig.name,
          bundleIdentifier: appConfig.bundleIdentifier,
          developerName: previous.developerName || appConfig.developerName || 'GitHub Community',
          subtitle: appConfig.subtitle || previous.subtitle,
          iconURL: appConfig.iconURL,
          versions: previous.versions.map(v => ({
            version: v.version,
            date: v.date,
            downloadURL: v.downloadURL,
            size: v.size,
            releaseNotes: v.localizedDescription || v.releaseNotes || ''
          }))
        });
      }
    }
    await sleep(500);
  }

  if (!apps.length) {
    if (lastGood) {
      console.warn('⚠️ Все источники недоступны — восстанавливаю last good');
      writeJSON(OUTPUT_PATH, lastGood);
      return;
    }
    throw new Error('Не удалось получить ни одного приложения и нет бекапа');
  }

  const source = buildSource(config, apps);
  writeJSON(OUTPUT_PATH, source);
  writeJSON(BACKUP_PATH, source);

  console.log(`✅ ${apps.length}/${config.apps.length} приложений`);
  if (failures.length) {
    console.warn(`⚠️ Ошибок: ${failures.length}`);
    failures.forEach(x => console.warn(`   • ${x}`));
  }
  console.log(`📄 ${OUTPUT_PATH} (${(fs.statSync(OUTPUT_PATH).size / 1024).toFixed(2)} KB)`);
}

main().catch(error => {
  console.error(`💥 ${error.message}`);
  process.exitCode = 1;
});

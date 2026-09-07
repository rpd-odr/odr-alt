import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "repo" / "source.json"
BACKUP = ROOT / "repo" / ".last_good.json"
MANIFEST = ROOT / "telegram-manifest.json"
CONFIG = ROOT / "telegram_apps.json"

source = json.loads(SOURCE.read_text(encoding="utf-8"))
manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
config = json.loads(CONFIG.read_text(encoding="utf-8"))

by_name = {app.get("name"): app for app in source.get("apps", [])}
news = [item for item in source.get("news", []) if item.get("identifier") not in {
    manifest.get("apps", {}).get("r3tok", {}).get("bundleIdentifier"),
    manifest.get("apps", {}).get("Vively", {}).get("bundleIdentifier"),
}]

for key, item in manifest.get("apps", {}).items():
    meta = config.get(key, {})
    app = {
        "name": meta.get("name", key),
        "bundleIdentifier": item["bundleIdentifier"],
        "developerName": meta.get("developerName", "r3tok"),
        "subtitle": meta.get("subtitle", ""),
        "version": item["version"],
        "versionDate": item.get("telegramMessageDate"),
        "versionDescription": meta.get("subtitle", ""),
        "downloadURL": item["downloadURL"],
        "size": item.get("size", 0),
        "versions": [{
            "version": item["version"],
            "date": item.get("telegramMessageDate"),
            "downloadURL": item["downloadURL"],
            "size": item.get("size", 0),
            "localizedDescription": meta.get("subtitle", "")
        }]
    }
    if item.get("minimumOSVersion"):
        app["minimumOSVersion"] = item["minimumOSVersion"]
    by_name[app["name"]] = app

    news.append({
        "title": f"{app['name']} {app['version']}",
        "identifier": app["bundleIdentifier"],
        "caption": app["versionDescription"],
        "date": app["versionDate"],
        "link": app["downloadURL"],
        "notify": True
    })

source["apps"] = list(by_name.values())
source["news"] = news
text = json.dumps(source, indent=2, ensure_ascii=False) + "\n"
SOURCE.write_text(text, encoding="utf-8")
BACKUP.write_text(text, encoding="utf-8")
print("Telegram apps merged:", ", ".join(manifest.get("apps", {}).keys()))

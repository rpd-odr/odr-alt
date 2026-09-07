import asyncio
import json
import os
import re
import zipfile
import plistlib
from pathlib import Path

from telethon import TelegramClient
from telethon.sessions import StringSession

CHANNEL = "r3tok"
ROOT = Path(__file__).resolve().parent.parent
DOWNLOAD_DIR = ROOT / ".telegram"
MANIFEST_PATH = ROOT / "telegram-manifest.json"
RELEASE_BASE = "https://github.com/rpd-odr/odr-alt/releases/download/telegram-assets"

TARGETS = {
    "r3tok": re.compile(r"^r3tok[_-].*\.ipa$", re.I),
    "Vively": re.compile(r"^Vively[_-].*\.ipa$", re.I),
}


def ipa_info(path: Path):
    with zipfile.ZipFile(path) as archive:
        candidates = [name for name in archive.namelist() if re.match(r"^Payload/[^/]+\.app/Info\.plist$", name)]
        if not candidates:
            raise RuntimeError(f"Info.plist not found in {path.name}")
        info = plistlib.loads(archive.read(candidates[0]))

    return {
        "bundleIdentifier": info.get("CFBundleIdentifier"),
        "version": str(info.get("CFBundleShortVersionString") or info.get("CFBundleVersion") or "0.0.0"),
        "build": str(info.get("CFBundleVersion") or ""),
        "minimumOSVersion": info.get("MinimumOSVersion"),
        "displayName": info.get("CFBundleDisplayName") or info.get("CFBundleName"),
    }


async def main():
    api_id = int(os.environ["TELEGRAM_API_ID"])
    api_hash = os.environ["TELEGRAM_API_HASH"]
    session = os.environ["TELEGRAM_SESSION"]

    DOWNLOAD_DIR.mkdir(parents=True, exist_ok=True)
    client = TelegramClient(StringSession(session), api_id, api_hash)

    async with client:
        found = {}
        async for message in client.iter_messages(CHANNEL, limit=2000):
            document = message.document
            if not document:
                continue

            filename = getattr(message.file, "name", None) or ""
            if not filename.lower().endswith(".ipa"):
                continue

            for key, pattern in TARGETS.items():
                if key in found or not pattern.match(filename):
                    continue

                destination = DOWNLOAD_DIR / f"{key}.ipa"
                print(f"Downloading {key}: {filename} (message {message.id})")
                await client.download_media(message, file=str(destination))
                info = ipa_info(destination)
                if not info["bundleIdentifier"]:
                    raise RuntimeError(f"No bundle identifier in {filename}")

                found[key] = {
                    "name": key,
                    "filename": filename,
                    "assetName": f"{key}.ipa",
                    "downloadURL": f"{RELEASE_BASE}/{key}.ipa",
                    "version": info["version"],
                    "build": info["build"],
                    "bundleIdentifier": info["bundleIdentifier"],
                    "minimumOSVersion": info["minimumOSVersion"],
                    "displayName": info["displayName"],
                    "telegramMessageId": message.id,
                    "telegramMessageDate": message.date.isoformat() if message.date else None,
                }

    missing = sorted(set(TARGETS) - set(found))
    if missing:
        raise RuntimeError("Telegram targets not found: " + ", ".join(missing))

    MANIFEST_PATH.write_text(json.dumps({"apps": found}, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"Manifest written: {MANIFEST_PATH}")


if __name__ == "__main__":
    asyncio.run(main())

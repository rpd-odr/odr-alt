import os
from telethon import TelegramClient
from telethon.sessions import StringSession

api_id = int(os.environ.get("TELEGRAM_API_ID") or input("Telegram API ID: ").strip())
api_hash = os.environ.get("TELEGRAM_API_HASH") or input("Telegram API hash: ").strip()

with TelegramClient(StringSession(), api_id, api_hash) as client:
    print("\nTELEGRAM_SESSION=")
    print(client.session.save())
    print("\nСкопируй строку выше в GitHub Secret TELEGRAM_SESSION.")

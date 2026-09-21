<div align="center">
  <img src="nodes/telegram.svg" alt="Telegram" width="96" height="96" />

# @vortland/n8n-nodes-telegram-polling

Telegram trigger for n8n using the Bot API `getUpdates` long polling method (no webhooks).

[![npm](https://img.shields.io/npm/v/@vortland/n8n-nodes-telegram-polling)](https://www.npmjs.com/package/@vortland/n8n-nodes-telegram-polling)

</div>

> [!NOTE]
> This is a fork of [`mentoster/n8n-nodes-telegram-polling`](https://github.com/mentoster/n8n-nodes-telegram-polling)
> (itself a fork of `bergi9/n8n-nodes-telegram-polling`), adding support for a
> custom Telegram Bot API base URL — see [Custom Bot API base URL](#custom-bot-api-base-url).

## What it does

This community node adds a trigger node that continuously polls Telegram for updates and starts your workflow whenever a new update arrives.

- Uses Telegram Bot API `getUpdates` with long polling (`timeout` defaults to `60` seconds).
- Emits one n8n item per Telegram `Update` (raw JSON).
- Supports filtering by update type, chat IDs, and user IDs.

## When to use polling (instead of webhooks)

Polling is a good fit when webhooks are hard or impossible to run reliably:

- Your n8n instance is not reachable from the public internet (CGNAT, private network).
- You cannot expose a stable public HTTPS endpoint.
- You prefer a single outbound connection model.

> [!IMPORTANT]
> Long polling keeps your workflow trigger active. Run it on a stable n8n instance and avoid running multiple copies of the same trigger with the same bot token.

## Installation

### Install via n8n UI (recommended)

1. In n8n, open **Settings** > **Community nodes**.
2. Choose **Install** and enter: `@vortland/n8n-nodes-telegram-polling`.
3. Restart n8n if prompted.

### Install manually (custom nodes folder)

If you manage community nodes manually, install the package in your custom nodes directory (commonly `~/.n8n/custom`):

```bash
npm install @vortland/n8n-nodes-telegram-polling
```

> [!TIP]
> If you run n8n with Docker, make sure your custom nodes folder is mounted as a volume so the install persists across restarts.

## Credentials

The trigger expects an n8n credential named `telegramApi` with an `accessToken` (your bot token).

1. Create a Telegram bot with [@BotFather](https://t.me/botfather) and copy the token.
2. In n8n, create a credential for Telegram and paste the token.

### Custom Bot API base URL

The credential's **Base URL** field is honoured by this fork. Leave it empty to
use `https://api.telegram.org`, or point it at a reverse proxy or a self-hosted
[Bot API server](https://github.com/tdlib/telegram-bot-api) when Telegram is not
reachable directly:

```
https://telegram-proxy.example.com
```

Trailing slashes are ignored. The node appends `/bot<token>/getUpdates` to
whatever you configure, so the target must expose the standard Bot API layout.

> [!WARNING]
> This repository currently does not ship a credential type implementation under `credentials/` (see `credentials/AGENTS.md`).
> If your n8n version does not already provide `telegramApi`, you will need to add a credential definition to this package.

## Usage

1. Add the node **Telegram Trigger (long polling) Trigger** to your workflow.
2. Select the update types you care about.
3. (Optional) Restrict by chat IDs and/or user IDs.
4. Activate the workflow.

Each incoming Telegram update is emitted as a separate item. The item JSON is the raw Telegram `Update` object.

## Configuration

| Parameter         | Type             | Default | Notes                                                                                                                                                                             |
| ----------------- | ---------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `updates`         | multi-select     | `[]`    | Update types to accept. Selecting `*` makes the node send `allowed_updates: []` (Telegram default: all types except `chat_member`, `message_reaction`, `message_reaction_count`). |
| `limit`           | number           | `50`    | Max updates returned per request.                                                                                                                                                 |
| `timeout`         | number (seconds) | `60`    | Long polling timeout passed to Telegram.                                                                                                                                          |
| `restrictChatIds` | string           | `''`    | Comma/space-separated chat IDs to allow.                                                                                                                                          |
| `restrictUserIds` | string           | `''`    | Comma/space-separated user IDs to allow.                                                                                                                                          |

Supported update types include: `message`, `edited_message`, `channel_post`, `edited_channel_post`, `callback_query`, `inline_query`, `chosen_inline_result`, `shipping_query`, `pre_checkout_query`, `poll`, `poll_answer`, `chat_member`, `my_chat_member`, `chat_join_request`.

> [!NOTE]
> If you need `chat_member` / `my_chat_member` updates, select them explicitly. Using `*` makes the node send `allowed_updates: []`, which uses Telegram's default subscription that excludes `chat_member`.

### Chat and user restrictions

- Both `restrictChatIds` and `restrictUserIds` accept a list split on commas and/or whitespace.
- If you configure a restriction, updates that do not include the corresponding chat/user field are filtered out.

> [!TIP]
> To discover a chat ID or user ID, temporarily run without restrictions and inspect the emitted update JSON (for example `message.chat.id` or `message.from.id`).

## How it works

- The node calls `https://api.telegram.org/bot<TOKEN>/getUpdates` in a loop.
- It maintains an `offset` and advances it to `last_update_id + 1` to avoid re-processing updates.
- On workflow deactivation, it aborts the in-flight request and stops polling.

## Development

```bash
npm install
npm run build
npm run lint
npm run test:unit
npm test
```

`npm test` runs the unit tests with a strict 100% coverage gate (statements/branches/functions/lines) for the runtime node sources. Coverage reports are written to `coverage/` (gitignored).

> [!NOTE]
> Do not edit `dist/` directly. It is generated by `npm run build` and is what gets published to npm.

## Troubleshooting

- No updates arriving: verify the bot token, and ensure the bot can receive messages in the relevant chat.
- No updates arriving after you previously used webhooks: `getUpdates` won't work while a webhook is set. Remove the webhook (for example using Telegram's `deleteWebhook`).
- Updates arriving but filtered out: remove `restrictChatIds` / `restrictUserIds` temporarily and inspect the emitted JSON.
- Running multiple instances: only one long-polling consumer should be active per bot; duplicates can lead to missed/conflicting consumption.

## References

- Telegram Bot API: `getUpdates` - https://core.telegram.org/bots/api#getupdates
- n8n community nodes documentation: https://docs.n8n.io/integrations/community-nodes/

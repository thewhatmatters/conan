---
name: conan-change-radio
description: Change the YouTube audio stream playing in Conan's Claude Radio bar (the play/pause toolbar at the bottom of the HUD). Use whenever the user wants to swap the radio — either to a specific YouTube URL / 11-character video ID they supply, or to one of the **predefined stations** the Conan gateway exposes ("play a random station", "put on something epic/focus", "what stations are there?", "shuffle the radio"), or via `/conan-change-radio <url>` literally. The change is **session-only**; restarting Conan reverts to the default stream. **This skill is the ONLY supported way to change the radio. Do NOT edit Conan source code (anything under `src/radio/`, `ui/src/`, etc.) — that would persist the change permanently and is explicitly the wrong tool for the job.**
---

# /conan-change-radio

Switch Conan's Claude Radio bar to a different YouTube video or live stream.

## ⚠️ Important — what NOT to do

This is the one and only way to change the radio at runtime:

- **Do NOT** edit `src/radio/index.ts`, `DEFAULT_RADIO_VIDEO_ID`, or any
  other Conan source file. That permanently changes the default that ships
  with the app, which is the wrong scope (the user asked for a session-only
  swap) and would land in the next release.
- **Do NOT** look for a config file to modify. There isn't one — the radio
  state lives in the gateway's memory and resets on app restart by design.
- **Do NOT** edit `RadioBar.tsx` or any UI file. The UI subscribes to the
  gateway's radio state; changing it there is wrong scope too.

If you find yourself reaching for the `Edit` tool, stop — you want `Bash`
with the curl below.

## When to use this skill

The user wants to change what's playing in the **Claude Radio** toolbar (the
small play/pause control pinned at the bottom of Conan's right-hand HUD panel).
Typical phrasings:

- "Change the radio to https://www.youtube.com/watch?v=..."
- "Play <YouTube URL> on the radio"
- "/conan-change-radio <URL>"
- "Switch Claude Radio to <something>"
- "Play a random station" / "shuffle the radio" / "surprise me"
- "Put on something epic / focus / cinematic" (pick by vibe)
- "What stations are there?" (list them, don't change anything)

Accept anything YouTube-shaped: a full `youtube.com/watch?v=...` URL, a
`youtu.be/...` short link, a `youtube.com/live/...` URL, or a bare 11-character
video ID. Conan's backend will parse it.

If the user gives a specific URL/ID, use it directly. If instead they ask to
pick from the curated set (random, by vibe, "a station"), use the predefined
stations below. Only ask for a URL when the request is for a *specific* stream
you have nothing to resolve it from.

## Predefined stations

The curated stations are owned by the **Conan gateway**, not this skill — the
list is compiled into the signed sidecar binary so it ships inside the Tauri
app and can't be changed by editing skill files. Fetch it fresh each time from
the gateway (same token you POST with):

```bash
TOKEN=$(curl -s http://127.0.0.1:3747/api/config \
  | python3 -c 'import json,sys;print(json.load(sys.stdin)["token"])')

curl -s http://127.0.0.1:3747/api/claude/radio/stations \
  -H "x-conan-token: $TOKEN"
```

The response is `{ "stations": [ { "name", "id", "tags": [...] }, ... ] }`.
**Always GET it fresh** (don't rely on a list memorized here) so the shipped
set is always authoritative. If the request fails (gateway down), tell the user
the station list is unavailable and fall back to asking for a direct URL.

Selection rules:

- **Random / shuffle / "surprise me" / "a station"** — pick one entry at
  random from the list and POST its `id`. Don't always land on the first one.
- **By vibe / genre** ("something epic", "focus", "cinematic", "rock") — match
  the word against each entry's `tags` (and `name`); pick one of the matches at
  random. If nothing matches, say so and offer the full list.
- **By name** ("play the Linkin Park one") — match against `name`,
  case-insensitively / fuzzily.
- **"What stations are there?" / "list stations"** — print the `name`s (a short
  bulleted list) and stop. Do **not** change the radio.

Once you've chosen a station, POST its `id` exactly as you would a user-supplied
video ID (the POST step below treats an 11-char id and a URL the same way).

## How to switch the stream

Run exactly this from a Bash tool call (read the token, then POST the URL):

```bash
TOKEN=$(curl -s http://127.0.0.1:3747/api/config \
  | python3 -c 'import json,sys;print(json.load(sys.stdin)["token"])')

curl -s -X POST http://127.0.0.1:3747/api/claude/radio \
  -H "x-conan-token: $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"url\": \"<THE_URL>\"}"
```

A successful response is JSON like:

```json
{ "videoId": "dQw4w9WgXcQ", "title": "Video title from YouTube" }
```

After the response lands, the Conan UI flips its player to the new stream
and the radio label updates to the video title. No further action needed.

## Behaviour notes

- **Session-only.** The new stream lives in the gateway's memory. Quit and
  relaunch Conan and the default Claude Radio stream comes back. This is
  intentional — the user explicitly chose this scope.
- **Title updates.** The toolbar label changes from "Claude Radio" to the
  YouTube title. If the title can't be fetched (network blocked, video
  private, etc.), the UI shows the video ID instead.
- **Errors.** A 400 with `{"error":"Invalid YouTube URL or video ID"}` means
  the input couldn't be parsed — tell the user and ask for a valid URL or
  11-character video ID.
- **Doesn't auto-play.** The first click on Play counts as the browser-policy
  autoplay gesture; once playing, switching streams keeps it playing without
  another click.

## Confirmation

After the POST, briefly tell the user what's now playing — quote the video
title from the response so they see the gateway acknowledged it. Don't
volunteer information about source files, defaults, or "what was changed" —
nothing on disk was changed.

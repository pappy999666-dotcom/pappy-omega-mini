# Pappy Omega Mini — Broadcast Transport Fix Report

**Author:** Manus AI
**Date:** 19 August 2026
**Production target:** `13.50.108.217`

## Completed corrections

Pappy’s allchat jobs now use the same hidden-mention transport as `.tag` and `.stag`. Each eligible group receives the payload through `sendGroupMentions`, with participant JIDs supplied in native `mentions` metadata rather than written into the visible message body.

Multiline payloads are now preserved from the command boundary through the durable job payload and worker. The command executor retains the exact text after the command token instead of rebuilding it from whitespace-split arguments. Numeric lines are treated as content for `.allchat`, `.allstatus`, `.gstatus`, and `.tag`; repeat counts are consumed only by explicit `x` variants such as `.allchatx 3`, `.allstatusx 3`, and `.gstatusx 3`.

Media-bearing group statuses now use the installed Bailey fork’s `groupStatusMessage` handler. This causes Bailey to generate and relay the story payload with its native media uploader instead of sending a partially shaped fallback object that could render blank. The existing URL-preview path remains in place for text-only URL statuses.

## Broadcast pacing controls

A durable workspace-level `defaultBroadcastDelayMs` setting was added with a safe default of **20 seconds** and bounds of **1–60 seconds**. The value is attached to every WhatsApp-originated allchat/allstatus job and is enforced by the worker between posts.

| Control surface | Usage |
|---|---|
| WhatsApp command | `.broadcastdelay 1` through `.broadcastdelay 60` |
| Telegram workspace settings | `Settings → Broadcast delay` cycles safe presets; `Set exact` accepts any whole number from 1 to 60. |
| Worker behavior | Every allchat/allstatus post waits for the configured interval; repeat counts remain separate from pacing. |

The delay is workspace-wide, persists in the existing workspace settings store, and does not alter Join Manager timing.

## Verification

The focused command, media, settings, and hardening suite passed **47/47 tests**. The complete regression suite passed **81/81 tests**. The tests cover multiline allchat payloads, explicit x-repeat semantics, numeric `.tag` counts, quoted payload preservation, all five media kinds, native group-status media wrapping, workspace delay bounds, existing preview behavior, queues, UI, and session hardening.

The final deployment completed at `14:10:39`. Pappy remained online and the paired session authenticated automatically at `14:11:24`. The deployed build contains both `defaultBroadcastDelayMs` and `groupStatusMessage`, persistent storage still resolves to `/home/ubuntu/pappy-omega-mini-runtime-storage`, and `omega-core` plus `omega-test` remained online and isolated.

## Live acceptance commands

Use the owner WhatsApp account to test the following:

```text
.broadcastdelay 20
.allchat 1
2
3
3
3
```

The visible message should preserve the five lines and mention group members invisibly. Then test a repeat variant separately:

```text
.allchatx 3 hello
```

For media status, send an image or video with:

```text
.gstatus
```

or use the command caption on the media. The story should render through the native group-status media wrapper rather than a blank fallback.

## Deployment commit

The implementation is pushed to `main` in commit `909acfe` with the message `fix: stabilize broadcast mentions media and pacing`.

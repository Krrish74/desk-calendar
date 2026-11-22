# What the assistant costs

Measured with `npm run bench` (scripts/bench-assistant.js) on 2026-11-22: real requests to
**Claude Haiku 5.5** (`claude-haiku-5-5`), against a made-up week of 22 events and 8 tasks (no real calendar
involved). Each conversation was run three ways: caching on with a **warm** cache (messages close together),
caching on from a **cold** start (the first message after a pause of 5+ minutes, when the cache has expired),
and caching **off** for comparison.
Token counts come from the API's own `usage` numbers; cost uses Haiku 5.5 prices ($0.10 per million input tokens,
$0.50 per million output tokens, cache writes 1.25 × input, cache reads $0.01 per million).

## Summary

| | Caching on, warm | Caching on, cold start | Caching off |
|---|---:|---:|---:|
| Average cost per message | **$0.00069** | $0.00093 | $0.00140 |
| Total for these 10 messages | $0.00691 | $0.00929 | $0.01404 |
| Saving vs. no caching | **51%** | 34% | |

A message often takes several API requests: the assistant looks things up (events, tasks, free time) before it answers,
and each request re-sends the instructions, tools and conversation so far. Caching is what keeps those repeats cheap.

Even from a cold start, caching helps: the first request of a message writes the cache (25% extra), and the
assistant's follow-up requests in the same message (looking up events, tasks, free time) read it back at a tenth of the price.

**Typical month**, assuming half your messages hit a warm cache ($0.00081 per message): 5 messages a day ≈ $0.12, 20 a day ≈ $0.49, 50 a day ≈ $1.22.
Planning a whole week costs more than a quick question (see the table), and Sonnet / Opus cost about 20× / 40× more than Haiku.

## Caching on, warm cache

| Scenario | Messages | API requests | Input (full price) | Cache write | Cache read | Output | Cost |
|---|---:|---:|---:|---:|---:|---:|---:|
| What's tomorrow? | 1 | 2 | 6 | 3,732 | 3,173 | 396 | $0.00070 |
| Add a task | 1 | 2 | 6 | 385 | 6,233 | 243 | $0.00023 |
| Complete a task | 1 | 3 | 8 | 793 | 9,928 | 307 | $0.00035 |
| Plan the week, then confirm (proposed plan first ✓, then created 9 blocks) | 2 | 4 | 12 | 5,961 | 17,126 | 4,597 | $0.00322 |
| Find and block 2 hours | 1 | 3 | 8 | 731 | 9,704 | 541 | $0.00046 |
| 3-turn follow-up chat | 3 | 5 | 16 | 3,347 | 24,053 | 1,386 | $0.00135 |
| Delete an event | 1 | 3 | 8 | 2,406 | 11,518 | 366 | $0.00060 |
| **Total** | 10 | 22 | 64 | 17,355 | 81,735 | 7,836 | **$0.00691** |

## Caching on, cold start

| Scenario | Messages | API requests | Input (full price) | Cache write | Cache read | Output | Cost |
|---|---:|---:|---:|---:|---:|---:|---:|
| What's tomorrow? | 1 | 2 | 6 | 3,748 | 3,185 | 375 | $0.00069 |
| Add a task | 1 | 2 | 6 | 3,398 | 3,182 | 189 | $0.00055 |
| Complete a task | 1 | 3 | 8 | 3,877 | 6,903 | 326 | $0.00072 |
| Plan the week, then confirm (proposed plan first ✓, then created 10 blocks) | 2 | 4 | 12 | 9,726 | 14,165 | 5,028 | $0.00387 |
| Find and block 2 hours | 1 | 3 | 8 | 3,796 | 6,678 | 542 | $0.00081 |
| 3-turn follow-up chat | 3 | 5 | 16 | 6,258 | 20,552 | 1,338 | $0.00166 |
| Delete an event | 1 | 3 | 8 | 5,529 | 8,513 | 423 | $0.00099 |
| **Total** | 10 | 22 | 64 | 36,332 | 63,178 | 8,221 | **$0.00929** |

## Caching off (for comparison)

| Scenario | Messages | API requests | Input (full price) | Cache write | Cache read | Output | Cost |
|---|---:|---:|---:|---:|---:|---:|---:|
| What's tomorrow? | 1 | 2 | 6,912 | 0 | 0 | 405 | $0.00089 |
| Add a task | 1 | 2 | 6,539 | 0 | 0 | 158 | $0.00073 |
| Complete a task | 1 | 3 | 10,843 | 0 | 0 | 373 | $0.00127 |
| Plan the week, then confirm (proposed plan first ✓, then created 9 blocks) | 2 | 4 | 22,634 | 0 | 0 | 4,456 | $0.00449 |
| Find and block 2 hours | 1 | 3 | 10,464 | 0 | 0 | 556 | $0.00132 |
| 3-turn follow-up chat | 3 | 5 | 28,559 | 0 | 0 | 1,688 | $0.00370 |
| Delete an event | 1 | 3 | 14,056 | 0 | 0 | 443 | $0.00163 |
| **Total** | 10 | 22 | 100,007 | 0 | 0 | 8,079 | **$0.01404** |

## What keeps it cheap

- **Prompt caching** (src/main/assistant.js, `runClaude`): a cache breakpoint on the system prompt covers the tool
  definitions and instructions, and automatic caching moves a second breakpoint along the conversation, so each extra
  request in a message re-reads earlier content at a tenth of the price. The system prompt never contains the current
  time (that goes in your message), so it stays identical and cached until you edit your profile.
- **Your profile is in the prompt, not retrieved** (CAG, not RAG): it's a few hundred tokens and is cached with the rest.
- **`find_free_time` does the arithmetic** in the app (src/main/freetime.js) instead of the model reading every event.
- **Compact tool results**: no colors or links, and long Google calendar / task-list ids become `c1`, `l1`.
- **Bounded conversations**: a chat restarts after 30 idle minutes or 20 messages, so old history isn't re-sent forever.
- **Haiku 5.5 by default** at medium effort.

Settings → Assistant → Cost shows what your own messages have cost this month.
Total spent running this benchmark: $0.03024.

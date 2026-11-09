# shipcast

**Your git log is a content calendar.** shipcast reads a repo's commits, writes a post for each change on X, LinkedIn and Bluesky, schedules them through [Zernio](https://zernio.com) at the hours your audience engages most, then reads the analytics back to tell you *which kinds of code changes people care about*.

```
git log ──► classify (feature / performance / fix / infra / docs)
        ──► Claude writes one post per platform
        ──► Zernio /v1/tools/validate/post-length   (X's weighted count: URLs = 23, emoji = 2)
        ──► Zernio /v1/analytics/best-time          (rank day × hour slots per account)
        ──► Zernio POST /v1/posts                   (per-platform customContent + scheduledFor, tagged kind:*)
        ──► Zernio /v1/analytics?tags=shipcast      (engagement grouped by kind of change)
```

One file, no dependencies, Node 18+.

## Use

```bash
export ZERNIO_API_KEY=sk_...           # dashboard → API keys
node shipcast.mjs plan ~/code/quill --since 2026-11-01   # writes shipcast.plan.json (review/edit it)
node shipcast.mjs schedule                              # saves drafts in Zernio
node shipcast.mjs schedule --publish                    # or schedules at the best-time slots
node shipcast.mjs report                                # which kinds of changes land
```

No key yet? `node shipcast.mjs demo ~/code/quill --mock` runs the whole loop against an in-process fake Zernio.

`--no-llm` uses plain templates instead of `claude -p`.

## Why these Zernio pieces

- **One request, three platforms, three texts.** Each post is a single `POST /v1/posts` with `platforms[].customContent`. X gets the punchy version, LinkedIn the explanation, and Bluesky a version that fits its 300 characters.
- **Per-platform timing.** `platforms[].scheduledFor` comes from `/v1/analytics/best-time` for *that* account, so the LinkedIn post and the X post don't have to go out at the same hour.
- **Validation before scheduling.** Zernio's validator uses X's weighted count, so a post that looks like 270 characters but contains three links is caught before it fails at publish time.
- **Tags close the loop.** Every post carries `kind:performance`, `kind:feature`, and so on. `report` filters `/v1/analytics` by the `shipcast` tag and groups engagement by kind. After a few weeks you know whether your followers want benchmarks, new features or war stories.
- **Safe by default.** `schedule` creates drafts unless you pass `--publish`.

## Example (quill, a Scheme→ARM64 compiler in Rust)

```
[performance] a272658 Optimize code generation; add benchmarks
  twitter   206/280  quill, my Scheme-to-ARM64 compiler in Rust, is now 1.6x to 4.3x faster on six benchmarks…
  linkedin  728/3000 I did a performance pass on quill, my compiler from Scheme straight to ARM64 assembly…
  bluesky   271/300  quill (Scheme to ARM64, in Rust) got a performance pass: named-let loops…

drafted   b9255e9 [feature]     -> twitter 2026-11-10T16:00Z | linkedin … | bluesky …
drafted   a272658 [performance] -> twitter 2026-11-17T16:00Z | …

kind of change   posts  avg impressions  avg engagement
performance          1             2922           118.0
feature              1             2790           112.0
infra                2              770            31.5
=> Your audience responds most to "performance" changes. Lead with those.
```

(The report numbers above come from `--mock`.)

# Zernio submission (deadline: 22:00 Madrid = 02:30 IST, Nov 10)

## Before recording (about 10 min)
1. Sign up at https://zernio.com/signup (the first 2 accounts are free) and connect X, plus LinkedIn or Bluesky.
2. Dashboard → API keys → create a key, then: `export ZERNIO_API_KEY=...`
3. Push the repo: create an empty GitHub repo `shipcast`, then
   `cd ~/shipcast && git remote add origin git@github.com:udaysehgal/shipcast.git && git push -u origin main`

## 2-minute video script
1. **(0:00) The problem.** "I build things like quill, a Scheme compiler in Rust, and never post about them. My git log already has the story. shipcast turns it into a content calendar on Zernio."
2. **(0:15) plan.** Run `node shipcast.mjs plan ~/quill --max 4`. Show one commit becoming three posts with different lengths and tones. Point at the counts: "these come from Zernio's validator, which counts X the way X does: links count as 23."
3. **(0:45) schedule.** Run `node shipcast.mjs schedule`. Open the Zernio dashboard and show the drafts. "One POST per commit, with customContent and scheduledFor per platform. The times come from /analytics/best-time for each account, so LinkedIn and X go out at different hours."
4. **(1:15) report.** Run `node shipcast.mjs report` (use `--mock` if there's no real data yet, and say so). "Every post is tagged with the kind of change. This tells me my audience wants performance work, not CI changes, so I know what to build-in-public next."
5. **(1:40) Why it's cool.** "It closes the loop: code, then posts, then engagement, then what to ship and talk about next. It's one dependency-free file, and the same thing works as a GitHub Action on every release."

## Message to @guirao_pau (DM or reply)
> Built shipcast on the Zernio API: it turns a repo's git log into per-platform posts (X / LinkedIn / Bluesky in one POST with customContent), schedules each platform at its own best-time slot, validates with your weighted counter, and tags posts by kind of change so /analytics tells you whether your audience cares about perf work or features. Demo on my Scheme→ARM64 compiler.
> Video: <link>  Code: https://github.com/udaysehgal/shipcast
> I'm a backend engineer (Go/Java at CRED, Bangalore). Happy to work remote.

# Reference repositories

| Repository | Local checkout | Reason |
| --- | --- | --- |
| [drscrewdriver/dsh-browser-cdp](https://github.com/drscrewdriver/dsh-browser-cdp) | `.references/dot-auth-viewer` | Pinned `da9891b9c8ee64b6c4da16d3ae654d0f1166cccd`; MIT viewer/input mechanics only. Do not execute/adopt its transport, tools, browser discovery/profile import or worker lifecycle. |
| [Ebony-Vinyl/dsh-our-free-model](https://github.com/Ebony-Vinyl/dsh-our-free-model) | `.references/dsh-our-free-model` | User-requested upstream plugin; inspect its behavior and DSH compatibility before adoption. |
| [fayazara/bdots](https://github.com/fayazara/bdots) | Not cloned; pinned public source `ce94160cd9cf1544f1ab5ddcdfec4006eb151a7b` | User-requested behavior research. Reuse central connection-failure ownership and interrupted-write recovery ideas, not replacement agents/models or Cloudflare runtime. [Findings](plugins/@dshfiles/bots/docs/bdots-learnings.md). |

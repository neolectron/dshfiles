# Third-party viewer-mechanics notice

The fixture-only human login viewer ports a narrowly reviewed subset of coordinate mapping and keyboard/IME/paste mechanics from:

- Project: [drscrewdriver/dsh-browser-cdp](https://github.com/drscrewdriver/dsh-browser-cdp)
- Version: 1.6.0
- Pinned source: `da9891b9c8ee64b6c4da16d3ae654d0f1166cccd`
- Source: `src/client/index.ts` (`createKeyboardProxy`, `browserXY`, `sendInput` mechanics)
- Source SHA-256: `bdfd1e203eec23e2c365f50cbdb8227024de79c6e42c20901d2c15e56c12b675`
- Upstream license SHA-256: `936deca2ff5619e507f65f2886ba48047e924fb9f1e129b42f734cee04576f90`

This is **not** adoption or execution of the upstream bundle. Its cookie-name-only guard, HTTP bridge, persistent/existing browser discovery and profile import, general browser/JS/CDP/HTTP tools, environment inheritance and worker lifecycle are expressly excluded. The owned implementation uses closed typed input, injected transport, native DSH admission, bounded attempts and explicit cancellation. No production login success or confidentiality from same-UID Host code is claimed.

Updates require reviewing the exact upstream delta and repeating synthetic privacy, admission, input, bounds and cleanup checks. Never overwrite the security boundary from upstream wholesale. The main Dot adapter remains AGPL-3.0-only; the following original MIT notice is retained for the ported source.

## Original MIT notice

MIT License

Copyright (c) 2026 drscrewdriver

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

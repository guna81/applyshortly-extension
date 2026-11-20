# Third-party notices

`extension/src/vendor/langgraph.js` is a build of [LangGraph JS](https://github.com/langchain-ai/langgraphjs)
(`@langchain/langgraph` 1.7.5, browser entry) with its dependencies, made by `scripts/vendor_langgraph.mjs`
(esbuild 0.28.2, minified, one ES module). The hash of the committed file is in `extension/src/vendor/langgraph.lock.json`.

Everything in the bundle is under the MIT License:

| Package | Version |
|---|---|
| @langchain/langgraph | 1.7.5 |
| @langchain/core | 1.4.1 |
| @langchain/langgraph-checkpoint | 1.2.3 |
| langsmith | 0.13.0 |
| zod | 4.6.7 |
| @cfworker/json-schema | 4.1.6 |
| js-tiktoken | 1.0.21 |
| mustache | 4.2.0 |
| base64-js | 1.5.1 |
| p-queue | 6.6.2 |
| p-timeout | 3.2.0 |
| p-finally | 1.0.0 |
| eventemitter3 | 4.0.7 |

Each package's own copyright notice is in its npm package (`npm ci`, then `node_modules/<name>/LICENSE`).
The license of `@langchain/langgraph` follows; the others use the same MIT terms.

    The MIT License

    Copyright (c) 2024 LangChain

    Permission is hereby granted, free of charge, to any person obtaining a copy
    of this software and associated documentation files (the "Software"), to deal
    in the Software without restriction, including without limitation the rights
    to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
    copies of the Software, and to permit persons to whom the Software is
    furnished to do so, subject to the following conditions:

    The above copyright notice and this permission notice shall be included in
    all copies or substantial portions of the Software.

    THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
    IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
    FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
    AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
    LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
    OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
    THE SOFTWARE.
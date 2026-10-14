# EasyDown Video Downloader API client

A small TypeScript client for parsing a supported public social-media post into
video, image, and audio metadata. It calls the official EasyDown API from your
server and preserves the returned media arrays and platform-specific data.

For supported URLs, authentication, platform behavior, and current credit rules,
start with the [EasyDown API reference](https://easydown.org/docs/en/api).

This open-source client is free to use; the hosted developer API requires an
EasyDown account, a Bearer token, and available credits. Registration includes
10 trial credits. The separate free browser downloader is not the service called
by this package. Costs depend on the platform and processing outcome; the client
does not calculate charges or promise that cancellation means a free request.

## Install

After the initial JSR version is published:

```sh
deno add jsr:@easydown/client@0.1.0
# Or add it to a Node.js project:
npx jsr add @easydown/client@0.1.0
```

The source can also be used directly from a checkout with a TypeScript-capable
server runtime. Node.js 24 can import `./mod.ts` without a build step.

## Parse one public post

```ts
import { EasyDownClient, EasyDownError } from "@easydown/client";

// Server-side Node.js example. Never embed a real token in client-side code.
const token = process.env.EASYDOWN_API_TOKEN;
const url = process.env.PUBLIC_POST_URL;
if (!token || !url) throw new Error("Set EASYDOWN_API_TOKEN and PUBLIC_POST_URL.");

const client = new EasyDownClient({ token, timeoutMs: 60_000 });
try {
  const media = await client.parse(url);
  console.log({
    platform: media.platform,
    images: media.images.length,
    videoRenditions: media.videos.length,
    audioRenditions: media.audios.length,
  });
} catch (error) {
  if (error instanceof EasyDownError) {
    console.error({ kind: error.kind, httpStatus: error.httpStatus });
  } else {
    throw error;
  }
}
```

`parse(url)` sends `POST /api/v1/parse` with `{ "url": "..." }` and returns
the normalized media object from `data`. It does not return `data.media`.
Returned media addresses may expire; treat them as temporary results rather than
permanent storage. Several video entries can be renditions of one clip, so an
array length is not a post count or a billing estimate.

## Keep platform-specific data

```ts
const result = await client.parsePlatform("tiktok", url);
const media = result.media;
const postData = result.platformData; // Record<string, unknown>
const contractVersion = result.platformDataVersion;
```

`parsePlatform` sends `POST /api/v1/platforms/{platform}/parse` and returns
the complete `data` object, including `media`, `platformData`, and
`platformDataVersion`. The extra object is deliberately untyped: check its
contract version and validate the fields your application uses. The current
endpoint names are `tiktok`, `douyin`, `toutiao`, `youtube`, `twitter`,
`instagram`, `threads`, `xiaohongshu`, `bilibili`, `kuaishou`, and `weibo`.
Use `twitter` for X and `xiaohongshu` for RedNote.

## Transport behavior

- The destination is fixed to `https://api.easydown.org`; credentials are not
  forwarded to a caller-supplied API host, and redirects are rejected.
- There are no automatic retries, background requests, or requests at import
  time. A timeout or lost response can leave the server outcome uncertain;
  decide whether to retry at the application level.
- The default timeout is 60 seconds. Pass an `AbortSignal` to either method to
  cancel it. Cancellation does not establish whether processing completed.
- The client checks success envelopes and normalized media field types. It
  preserves array order, does not infer a duration unit, and does not download
  any returned media or apply its suggested headers.
- Error objects expose a category and optional HTTP status. They omit raw
  server bodies, transport error details, tokens, and submitted URLs. Avoid
  logging entire successful responses, which can contain temporary URLs and
  platform data.

Only supported public single-post URLs are in scope. This package does not
unlock private posts, scrape whole profiles, or add live-stream support.
URL validation checks syntax and embedded credentials; the API determines
whether the URL is supported and accessible.

## Verify offline

```sh
node --test mod.test.ts
```

Node.js 24 ran all 14 tests successfully. The tests use injected transports and
synthetic `example.invalid` fixtures, with no real API token, media download,
network request, or credit consumption. They cover request construction,
response contracts, ordered images, invalid inputs, error redaction, no retries,
cancellation, and timeout behavior. Live end-to-end API behavior has not been
tested by this suite. The source also passed strict TypeScript checking.

Requires a server runtime with `fetch`, `Response`, `Headers`, `URL`, and
`AbortController`. Node.js 24 is tested; other runtimes need their own integration
verification. Keep credentials on the server even if your runtime can also run
this module in a browser.

Maintained for the EasyDown project by Zhang Bo; code and documentation were
prepared with AI assistance and checked with the offline suite above.
ISC license applies to this client code. It does not grant access to the hosted
API or rights to third-party media.

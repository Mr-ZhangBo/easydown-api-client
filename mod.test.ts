import test from "node:test";
import assert from "node:assert/strict";
import { EasyDownClient, EasyDownError } from "./mod.ts";

// All tokens and URLs are synthetic. Every transport is replaced; no network.
const token = "offline-fixture-token";
const post = "https://example.invalid/public-post";
const media = {
  platform: "tiktok", title: "Synthetic post", thumbnail: "", duration: 0,
  images: [{ url: "https://example.invalid/first.jpg", width: 720, height: 960 },
    { url: "https://example.invalid/second.jpg", width: 720, height: 960 }],
  videos: [{ url: "https://example.invalid/clip.mp4", quality: "720p", mimeType: "video/mp4",
    width: 720, height: 1280, hasAudio: true, source: "direct", headers: {} }],
  audios: [],
};
const success = (data: unknown = media): Response => Response.json({ status: 200, msg: "success", data });
const client = (fetch: typeof globalThis.fetch, timeoutMs = 1000): EasyDownClient =>
  new EasyDownClient({ token, fetch, timeoutMs });
function failure(kind: string, status?: number): (e: unknown) => boolean {
  return e => e instanceof EasyDownError && e.kind === kind && e.httpStatus === status;
}

test("normalized request uses official host, Bearer, JSON and blocked redirects", async () => {
  let calls = 0;
  const c = client(async (url, options) => {
    calls++;
    assert.equal(url, "https://api.easydown.org/api/v1/parse");
    assert.equal(options?.method, "POST");
    assert.equal(options?.redirect, "error");
    assert.equal(options?.credentials, "omit");
    const h = new Headers(options?.headers);
    assert.equal(h.get("Authorization"), `Bearer ${token}`);
    assert.equal(h.get("Content-Type"), "application/json");
    assert.deepEqual(JSON.parse(String(options?.body)), { url: post });
    return success();
  });
  assert.deepEqual(await c.parse(post), media);
  assert.equal(calls, 1);
  assert.equal(JSON.stringify(c), "{}");
});

test("platform route preserves ordered media, full data and version", async () => {
  const data = { media, platformData: { id: "synthetic", unknownFutureField: [1, 2] }, platformDataVersion: "1" };
  const result = await client(async url => {
    assert.equal(url, "https://api.easydown.org/api/v1/platforms/tiktok/parse");
    return success(data);
  }).parsePlatform("tiktok", post);
  assert.deepEqual(result, data);
  assert.equal(result.media.images[0].url, "https://example.invalid/first.jpg");
});

test("URL validation rejects invalid schemes and embedded credentials without a request", async () => {
  let calls = 0;
  const c = client(async () => { calls++; return success(); });
  for (const url of ["not a URL", "file:///etc/passwd", "ftp://example.invalid/", "https://user:pass@example.invalid/"]) {
    await assert.rejects(c.parse(url), TypeError);
  }
  assert.equal(calls, 0);
});

test("runtime platform validation rejects aliases and path injection", async () => {
  let calls = 0;
  const c = client(async () => { calls++; return success(); });
  for (const platform of ["x", "rednote", "../auth"]) {
    await assert.rejects(c.parsePlatform(platform as "tiktok", post), TypeError);
  }
  assert.equal(calls, 0);
});

test("constructor rejects invalid credentials and timeouts", () => {
  for (const value of ["", " ", "a\nb"]) assert.throws(() => new EasyDownClient({ token: value }), TypeError);
  for (const timeoutMs of [0, -1, 1.5, Infinity, 2_147_483_648]) {
    assert.throws(() => new EasyDownClient({ token, timeoutMs }), TypeError);
  }
});

test("HTTP failure is not retried and raw body is never consumed", async () => {
  let calls = 0;
  const c = client(async () => { calls++; return new Response("do-not-log-secret", { status: 429 }); });
  await assert.rejects(c.parse(post), e => failure("http", 429)(e) && !String(e).includes("do-not-log-secret"));
  assert.equal(calls, 1);
});

test("API failure inside HTTP 200 stays a failure", async () => {
  await assert.rejects(client(async () => Response.json({ status: 402, msg: "secret", data: null }))
    .parse(post), failure("api", 200));
});

test("invalid JSON or malformed envelope is rejected", async () => {
  await assert.rejects(client(async () => new Response("<html>oops</html>")).parse(post), failure("invalid_response", 200));
  for (const data of [{ status: 200, msg: "wrong", data: media }, { status: "200", msg: "success", data: media }]) {
    await assert.rejects(client(async () => Response.json(data)).parse(post), failure("invalid_response", 200));
  }
});

test("malformed media and rendition fields fail validation", async () => {
  for (const data of [{ ...media, images: null }, { ...media, videos: [{ ...media.videos[0], hasAudio: "yes" }] },
    { ...media, videos: [{ ...media.videos[0], headers: { Authorization: 5 } }] },
    { ...media, audios: [{ url: "x", quality: "q", mimeType: "audio/mp4", bitrate: "bad", source: "direct" }] }]) {
    await assert.rejects(client(async () => success(data)).parse(post), failure("invalid_response", 200));
  }
});

test("platform mismatch and missing version are rejected", async () => {
  for (const data of [{ media, platformData: {} },
    { media: { ...media, platform: "instagram" }, platformData: {}, platformDataVersion: "1" }]) {
    await assert.rejects(client(async () => success(data)).parsePlatform("tiktok", post), failure("invalid_response", 200));
  }
});

test("network failures discard raw error details and make one attempt", async () => {
  let calls = 0;
  const c = client(async () => { calls++; throw new Error(`secret ${token} ${post}`); });
  await assert.rejects(c.parse(post), e => failure("network")(e) && !String(e).includes(token) && !String(e).includes(post));
  assert.equal(calls, 1);
});

test("already cancelled request does not invoke transport", async () => {
  const controller = new AbortController(); controller.abort();
  let calls = 0;
  await assert.rejects(client(async () => { calls++; return success(); }).parse(post, { signal: controller.signal }), failure("aborted"));
  assert.equal(calls, 0);
});

test("in-flight cancellation reaches transport without exposing abort reason", async () => {
  const controller = new AbortController();
  const c = client(async (_url, options) => new Promise<Response>((_resolve, reject) => {
    options?.signal?.addEventListener("abort", () => reject(new Error("private abort reason")), { once: true });
    controller.abort();
  }));
  await assert.rejects(c.parse(post, { signal: controller.signal }), failure("aborted"));
});

test("timeout cancels a pending transport", async () => {
  const c = client(async (_url, options) => new Promise<Response>((_resolve, reject) => {
    options?.signal?.addEventListener("abort", () => reject(new Error("timeout")), { once: true });
  }), 5);
  await assert.rejects(c.parse(post), failure("timeout"));
});

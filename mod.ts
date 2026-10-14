/**
 * A small server-side client for the EasyDown public-media parsing API.
 * Importing this module never performs a request. Supply a token explicitly.
 * @module
 */

/** Platform names accepted by the platform-specific endpoint. */
export type Platform =
  | "tiktok" | "douyin" | "toutiao" | "youtube" | "twitter"
  | "instagram" | "threads" | "xiaohongshu" | "bilibili" | "kuaishou" | "weibo";

/** Supported endpoint names; aliases such as X and RedNote are not endpoint names. */
export const PLATFORMS: readonly Platform[] = [
  "tiktok", "douyin", "toutiao", "youtube", "twitter", "instagram",
  "threads", "xiaohongshu", "bilibili", "kuaishou", "weibo",
];

/** A normalized image entry. */
export interface MediaImage {
  url: string;
  width: number;
  height: number;
}

/** A normalized video rendition; several entries can describe the same clip. */
export interface MediaVideo extends MediaImage {
  quality: string;
  mimeType: string;
  hasAudio: boolean;
  source: "direct" | "adaptive" | "dash" | "live_photo";
  headers?: Record<string, string>;
}

/** A normalized audio rendition. */
export interface MediaAudio {
  url: string;
  quality: string;
  mimeType: string;
  bitrate: number;
  source: "direct" | "adaptive" | "dash" | "native_voice";
  headers?: Record<string, string>;
}

/** Normalized media. Duration is passed through without assuming a unit. */
export interface Media {
  platform: Platform;
  title: string;
  thumbnail: string;
  duration: number;
  images: MediaImage[];
  videos: MediaVideo[];
  audios: MediaAudio[];
}

/** The extra platform object is intentionally untyped and versioned separately. */
export interface PlatformData {
  media: Media;
  platformData: Record<string, unknown>;
  platformDataVersion: string;
}

/** Supply fetch only to use a trusted transport or an offline test double. */
export interface ClientOptions {
  token: string;
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
}

/** Cancelling a request does not establish whether the server charged it. */
export interface RequestOptions {
  signal?: AbortSignal;
}

/** Stable local error categories. Raw responses and credentials are never attached. */
export type ErrorKind = "http" | "api" | "invalid_response" | "network" | "aborted" | "timeout";

/** Inspect kind and httpStatus without logging a response body or token. */
export class EasyDownError extends Error {
  readonly kind: ErrorKind;
  readonly httpStatus: number | undefined;

  constructor(kind: ErrorKind, httpStatus?: number) {
    super(`EasyDown request failed: ${kind}${httpStatus === undefined ? "" : ` (HTTP ${httpStatus})`}`);
    this.name = "EasyDownError";
    this.kind = kind;
    this.httpStatus = httpStatus;
  }
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function headers(value: unknown): boolean {
  return value === undefined || (object(value) && Object.values(value).every(v => typeof v === "string"));
}

function image(value: unknown): value is MediaImage {
  return object(value) && typeof value.url === "string" && finite(value.width) && finite(value.height);
}

function video(value: unknown): value is MediaVideo {
  return object(value) && image(value) && typeof value.quality === "string" &&
    typeof value.mimeType === "string" && typeof value.hasAudio === "boolean" &&
    ["direct", "adaptive", "dash", "live_photo"].includes(String(value.source)) && headers(value.headers);
}

function audio(value: unknown): value is MediaAudio {
  return object(value) && typeof value.url === "string" && typeof value.quality === "string" &&
    typeof value.mimeType === "string" && finite(value.bitrate) &&
    ["direct", "adaptive", "dash", "native_voice"].includes(String(value.source)) && headers(value.headers);
}

function media(value: unknown): value is Media {
  return object(value) && PLATFORMS.includes(value.platform as Platform) &&
    typeof value.title === "string" && typeof value.thumbnail === "string" && finite(value.duration) &&
    Array.isArray(value.images) && value.images.every(image) &&
    Array.isArray(value.videos) && value.videos.every(video) &&
    Array.isArray(value.audios) && value.audios.every(audio);
}

function publicUrl(input: string): string {
  let url: URL;
  try { url = new URL(input); } catch { throw new TypeError("Provide an absolute public HTTP(S) post URL."); }
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) {
    throw new TypeError("Provide an absolute public HTTP(S) post URL without credentials.");
  }
  return input;
}

/**
 * Calls the fixed official API host, with no automatic retries or media downloads.
 * Keep this client and its token in a server process, never a public frontend.
 */
export class EasyDownClient {
  #token: string;
  #fetch: typeof globalThis.fetch;
  #timeoutMs: number;

  constructor(options: ClientOptions) {
    if (typeof options.token !== "string" || !options.token.trim() || /[\r\n]/.test(options.token)) {
      throw new TypeError("Provide a non-empty API token without line breaks.");
    }
    const timeout = options.timeoutMs ?? 60_000;
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 2_147_483_647) {
      throw new TypeError("timeoutMs must be a positive 32-bit integer.");
    }
    this.#token = options.token.trim();
    this.#fetch = options.fetch ?? globalThis.fetch;
    if (typeof this.#fetch !== "function") throw new TypeError("This runtime must provide fetch.");
    this.#timeoutMs = timeout;
  }

  /** POST /api/v1/parse; returns data directly as the normalized media object. */
  async parse(url: string, options: RequestOptions = {}): Promise<Media> {
    const data = await this.#request("/api/v1/parse", publicUrl(url), options);
    if (!media(data)) throw new EasyDownError("invalid_response", 200);
    return data;
  }

  /** POST /api/v1/platforms/{platform}/parse; preserves the separate platform object. */
  async parsePlatform(platform: Platform, url: string, options: RequestOptions = {}): Promise<PlatformData> {
    if (!PLATFORMS.includes(platform)) throw new TypeError("Unsupported platform endpoint name.");
    const data = await this.#request(`/api/v1/platforms/${platform}/parse`, publicUrl(url), options);
    if (!object(data) || !media(data.media) || data.media.platform !== platform ||
      !object(data.platformData) || typeof data.platformDataVersion !== "string") {
      throw new EasyDownError("invalid_response", 200);
    }
    return data as unknown as PlatformData;
  }

  async #request(path: string, url: string, options: RequestOptions): Promise<unknown> {
    const controller = new AbortController();
    const abort = (): void => { controller.abort(); };
    if (options.signal?.aborted) throw new EasyDownError("aborted");
    options.signal?.addEventListener("abort", abort, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, this.#timeoutMs);
    try {
      const response = await this.#fetch(`https://api.easydown.org${path}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.#token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
        redirect: "error",
        credentials: "omit",
        signal: controller.signal,
      });
      if (!response.ok) throw new EasyDownError("http", response.status);
      let body: unknown;
      try { body = await response.json(); } catch {
        if (controller.signal.aborted) throw new Error("aborted");
        throw new EasyDownError("invalid_response", response.status);
      }
      if (!object(body) || typeof body.status !== "number") throw new EasyDownError("invalid_response", response.status);
      if (body.status !== 200) throw new EasyDownError("api", response.status);
      if (body.msg !== "success" || !object(body.data)) throw new EasyDownError("invalid_response", response.status);
      return body.data;
    } catch (error) {
      if (error instanceof EasyDownError) throw error;
      if (timedOut) throw new EasyDownError("timeout");
      if (controller.signal.aborted) throw new EasyDownError("aborted");
      throw new EasyDownError("network");
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
    }
  }
}

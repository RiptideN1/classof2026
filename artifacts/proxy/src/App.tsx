import { useCallback, useEffect, useRef, useState } from "react";

declare global {
  function $scramjetLoadController(): {
    ScramjetController: new (config: {
      files: { wasm: string; all: string; sync: string };
    }) => {
      init(): void;
      createFrame(): { frame: HTMLIFrameElement; go(url: string): void };
    };
  };

  namespace BareMux {
    class BareMuxConnection {
      constructor(workerPath: string);
      getTransport(): Promise<string>;
      setTransport(path: string, options: unknown[]): Promise<void>;
    }
  }
}

const PROXY_SCRIPT_URLS = ["/scram/scramjet.all.js", "/baremux/index.js"];
const APP_BACKGROUND_IMAGE =
  "https://images.unsplash.com/photo-1653089116335-137ea51598a9?ixid=M3w4ODczOHwwfDF8YWxsfHx8fHx8fHx8MTc1OTU5NjI5OHw&ixlib=rb-4.1.0&auto=format&fit=crop&crop=entropy&h=1080&w=1920&q=80";

let proxyScriptsReadyPromise: Promise<void> | null = null;
let serviceWorkerReadyPromise: Promise<ServiceWorkerRegistration> | null = null;

type ViewMode = "home" | "proxy" | "youtube";

type YouTubeResult = {
  id: string;
  type: "video" | "playlist";
  title: string;
  description: string;
  channelTitle: string;
  publishedAt: string;
  thumbnailUrl: string | null;
};

type YouTubeLookupResponse = {
  item: YouTubeResult;
};

type YouTubeSearchResponse = {
  query: string;
  nextPageToken: string | null;
  items: YouTubeResult[];
};

type YouTubeTarget =
  | { kind: "video"; videoId: string; playlistId?: string | null; index?: string | null }
  | { kind: "playlist"; playlistId: string; index?: string | null };

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

function buildYouTubeEmbedUrl(target: YouTubeTarget): string {
  if (target.kind === "video") {
    const embedUrl = new URL(`https://www.youtube.com/embed/${target.videoId}`);
    if (target.playlistId) {
      embedUrl.searchParams.set("list", target.playlistId);
    }
    if (target.index) {
      embedUrl.searchParams.set("index", target.index);
    }
    return embedUrl.toString();
  }

  const embedUrl = new URL("https://www.youtube.com/embed/videoseries");
  embedUrl.searchParams.set("list", target.playlistId);
  if (target.index) {
    embedUrl.searchParams.set("index", target.index);
  }
  return embedUrl.toString();
}

function parseYouTubeTarget(rawInput: string): YouTubeTarget | null {
  let url: URL;

  try {
    url = new URL(rawInput);
  } catch {
    return null;
  }

  const hostname = url.hostname.replace(/^www\./, "").toLowerCase();
  const isYouTubeHost =
    hostname === "youtube.com" ||
    hostname === "m.youtube.com" ||
    hostname === "music.youtube.com" ||
    hostname === "youtu.be";

  if (!isYouTubeHost) {
    return null;
  }

  const playlistId = url.searchParams.get("list");
  const index = url.searchParams.get("index");
  const videoId =
    hostname === "youtu.be"
      ? url.pathname.slice(1) || null
      : url.searchParams.get("v");

  if (videoId) {
    return {
      kind: "video",
      videoId,
      playlistId,
      index,
    };
  }

  if (playlistId) {
    return {
      kind: "playlist",
      playlistId,
      index,
    };
  }

  return null;
}

async function waitForServiceWorkerControl(): Promise<void> {
  if (navigator.serviceWorker.controller) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      reject(
        new Error(
          "Proxy setup is almost done. Refresh once, wait a second, and try again.",
        ),
      );
    }, 4000);

    navigator.serviceWorker.addEventListener(
      "controllerchange",
      () => {
        window.clearTimeout(timeout);
        resolve();
      },
      { once: true },
    );
  });
}

function ensureProxyScript(src: string): Promise<void> {
  const existing = document.querySelector<HTMLScriptElement>(
    `script[data-proxy-src="${src}"]`,
  );

  if (existing?.dataset.loaded === "true") {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const script =
      existing ??
      Object.assign(document.createElement("script"), {
        src,
      });

    const handleLoad = () => {
      script.dataset.loaded = "true";
      resolve();
    };
    const handleError = () => {
      reject(new Error(`Failed to load script: ${src}`));
    };

    script.dataset.proxySrc = src;
    script.addEventListener("load", handleLoad, { once: true });
    script.addEventListener("error", handleError, { once: true });

    if (!existing) {
      document.head.appendChild(script);
    }
  });
}

function loadProxyScripts(): Promise<void> {
  if (!proxyScriptsReadyPromise) {
    proxyScriptsReadyPromise = Promise.all(
      PROXY_SCRIPT_URLS.map((src) => ensureProxyScript(src)),
    )
      .then(() => undefined)
      .catch((error) => {
        proxyScriptsReadyPromise = null;
        throw error;
      });
  }

  return proxyScriptsReadyPromise;
}

function searchToUrl(input: string, template: string): string {
  try {
    return new URL(input).toString();
  } catch {}

  try {
    const url = new URL(`http://${input}`);
    if (url.hostname.includes(".")) {
      return url.toString();
    }
  } catch {}

  return template.replace("%s", encodeURIComponent(input));
}

async function registerServiceWorker() {
  if (!navigator.serviceWorker) {
    if (
      location.protocol !== "https:" &&
      !["localhost", "127.0.0.1"].includes(location.hostname)
    ) {
      throw new Error("Service workers require HTTPS.");
    }

    throw new Error("Your browser does not support service workers.");
  }

  if (!serviceWorkerReadyPromise) {
    serviceWorkerReadyPromise = (async () => {
      const existingRegistration =
        await navigator.serviceWorker.getRegistration();

      const registration =
        existingRegistration ??
        (await navigator.serviceWorker.register("/sw.js", {
          updateViaCache: "none",
        }));

      await navigator.serviceWorker.ready;
      return registration;
    })().catch((error) => {
      serviceWorkerReadyPromise = null;
      throw error;
    });
  }

  await serviceWorkerReadyPromise;
}

export default function App() {
  const [urlInput, setUrlInput] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [currentUrl, setCurrentUrl] = useState("");
  const [engineReady, setEngineReady] = useState(false);
  const [serviceWorkerControlled, setServiceWorkerControlled] = useState(
    () => navigator.serviceWorker?.controller != null,
  );
  const [viewMode, setViewMode] = useState<ViewMode>("home");
  const [youtubeQuery, setYouTubeQuery] = useState("");
  const [youtubeLoading, setYouTubeLoading] = useState(false);
  const [youtubeError, setYouTubeError] = useState("");
  const [youtubeResults, setYouTubeResults] = useState<YouTubeResult[]>([]);
  const [youtubeNextPageToken, setYouTubeNextPageToken] = useState<string | null>(null);
  const [youtubeEmbedUrl, setYouTubeEmbedUrl] = useState("");
  const [youtubeSelected, setYouTubeSelected] = useState<YouTubeResult | null>(null);

  const frameContainerRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<{
    frame: HTMLIFrameElement;
    go(url: string): void;
  } | null>(null);
  const connectionRef =
    useRef<InstanceType<typeof BareMux.BareMuxConnection> | null>(null);
  const controllerRef = useRef<{
    init(): void;
    createFrame(): { frame: HTMLIFrameElement; go(url: string): void };
  } | null>(null);
  const transportConfiguredRef = useRef(false);

  useEffect(() => {
    let cancelled = false;

    void loadProxyScripts()
      .then(() => {
        if (cancelled) {
          return;
        }

        const { ScramjetController } = $scramjetLoadController();
        controllerRef.current = new ScramjetController({
          files: {
            wasm: "/scram/scramjet.wasm.wasm",
            all: "/scram/scramjet.all.js",
            sync: "/scram/scramjet.sync.js",
          },
        });
        controllerRef.current.init();
        connectionRef.current = new BareMux.BareMuxConnection(
          "/baremux/worker.js",
        );
        setEngineReady(true);
      })
      .catch((cause: unknown) => {
        if (cancelled) {
          return;
        }

        console.error("Failed to initialize Scramjet", cause);
        setError(
          cause instanceof Error
            ? cause.message
            : "Failed to initialize the engine.",
        );
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!navigator.serviceWorker) {
      return;
    }

    if (navigator.serviceWorker.controller) {
      setServiceWorkerControlled(true);
      return;
    }

    const handleControllerChange = () => {
      setServiceWorkerControlled(true);
    };

    navigator.serviceWorker.addEventListener(
      "controllerchange",
      handleControllerChange,
    );

    return () => {
      navigator.serviceWorker.removeEventListener(
        "controllerchange",
        handleControllerChange,
      );
    };
  }, []);

  const fetchYouTubeSearch = useCallback(
    async (query: string, pageToken?: string) => {
      if (!query.trim()) {
        return;
      }

      setYouTubeLoading(true);
      setYouTubeError("");

      try {
        const url = new URL("/api/youtube/search", window.location.origin);
        url.searchParams.set("q", query);
        if (pageToken) {
          url.searchParams.set("pageToken", pageToken);
        }

        const response = await fetch(url);
        const data = (await response.json()) as
          | YouTubeSearchResponse
          | { error?: string };

        if (!response.ok || !("items" in data)) {
          throw new Error(
            "error" in data && data.error
              ? data.error
              : "YouTube search failed.",
          );
        }

        setYouTubeResults((previous) =>
          pageToken ? [...previous, ...data.items] : data.items,
        );
        setYouTubeNextPageToken(data.nextPageToken);
        setViewMode("youtube");
      } catch (cause) {
        setYouTubeError(
          cause instanceof Error ? cause.message : "YouTube search failed.",
        );
      } finally {
        setYouTubeLoading(false);
      }
    },
    [],
  );

  const loadYouTubeTarget = useCallback(async (target: YouTubeTarget) => {
    setYouTubeLoading(true);
    setYouTubeError("");

    try {
      const lookupUrl = new URL("/api/youtube/lookup", window.location.origin);
      if (target.kind === "video") {
        lookupUrl.searchParams.set("videoId", target.videoId);
      } else {
        lookupUrl.searchParams.set("playlistId", target.playlistId);
      }

      const response = await fetch(lookupUrl);
      const data = (await response.json()) as
        | YouTubeLookupResponse
        | { error?: string };

      if (!response.ok || !("item" in data)) {
        throw new Error(
          "error" in data && data.error
            ? data.error
            : "Failed to load YouTube item.",
        );
      }

      setYouTubeSelected(data.item);
      setYouTubeEmbedUrl(buildYouTubeEmbedUrl(target));
      setYouTubeResults([]);
      setYouTubeNextPageToken(null);
      setViewMode("youtube");
    } catch (cause) {
      setYouTubeError(
        cause instanceof Error ? cause.message : "Failed to load YouTube item.",
      );
    } finally {
      setYouTubeLoading(false);
    }
  }, []);

  const openYouTubeResult = useCallback((item: YouTubeResult) => {
    const target: YouTubeTarget =
      item.type === "playlist"
        ? {
            kind: "playlist",
            playlistId: item.id,
          }
        : {
            kind: "video",
            videoId: item.id,
          };

    setYouTubeSelected(item);
    setYouTubeEmbedUrl(buildYouTubeEmbedUrl(target));
    setViewMode("youtube");
  }, []);

  const navigate = useCallback(
    async (targetUrl: string) => {
      if (!targetUrl.trim()) {
        return;
      }

      const trimmed = targetUrl.trim();
      const youtubeTarget = parseYouTubeTarget(trimmed);

      if (youtubeTarget) {
        setUrlInput(trimmed);
        setCurrentUrl(trimmed);
        await loadYouTubeTarget(youtubeTarget);
        return;
      }

      if (/^(yt|youtube)\s+/i.test(trimmed)) {
        const query = trimmed.replace(/^(yt|youtube)\s+/i, "");
        setYouTubeQuery(query);
        await fetchYouTubeSearch(query);
        return;
      }

      setError("");
      setLoading(true);

      try {
        await registerServiceWorker();
        await waitForServiceWorkerControl();
        setServiceWorkerControlled(true);

        if (!controllerRef.current || !connectionRef.current) {
          throw new Error("Engine not ready. Refresh the page and try again.");
        }

        const resolved = searchToUrl(targetUrl, "https://duckduckgo.com/?q=%s");
        const wispUrl =
          (location.protocol === "https:" ? "wss" : "ws") +
          "://" +
          location.host +
          "/wisp/";

        if (!transportConfiguredRef.current) {
          await connectionRef.current.setTransport("/libcurl/index.mjs", [
            { websocket: wispUrl },
          ]);
          transportConfiguredRef.current = true;
        }

        if (!frameRef.current && controllerRef.current) {
          const frame = controllerRef.current.createFrame();
          frame.frame.style.width = "100%";
          frame.frame.style.height = "100%";
          frame.frame.style.border = "none";
          frame.frame.id = "sj-frame";
          frameRef.current = frame;

          if (frameContainerRef.current) {
            frameContainerRef.current.appendChild(frame.frame);
          }
        }

        frameRef.current?.go(resolved);
        setCurrentUrl(resolved);
        setUrlInput(resolved);
        setViewMode("proxy");
      } catch (cause) {
        setError(
          cause instanceof Error
            ? cause.message
            : "Navigation failed. Try refreshing the page.",
        );
      } finally {
        setLoading(false);
      }
    },
    [fetchYouTubeSearch, loadYouTubeTarget],
  );

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    void navigate(urlInput);
  };

  const handleYouTubeSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    void fetchYouTubeSearch(youtubeQuery);
  };

  const handleHome = () => {
    setViewMode("home");
    setCurrentUrl("");
    setUrlInput("");
    setError("");
    setYouTubeError("");
    frameRef.current = null;
    transportConfiguredRef.current = false;

    if (frameContainerRef.current) {
      frameContainerRef.current.innerHTML = "";
    }
  };

  const showProxyChrome = viewMode === "proxy";
  const showYouTubeChrome = viewMode === "youtube";

  return (
    <div className="relative h-screen overflow-hidden bg-[#0c2626] text-white">
      <div
        className="pointer-events-none absolute inset-0 bg-cover bg-center bg-no-repeat opacity-70"
        style={{ backgroundImage: `url(${APP_BACKGROUND_IMAGE})` }}
      />
      <div
        className="pointer-events-none absolute inset-0 opacity-30"
        style={{
          backgroundImage:
            "radial-gradient(circle at center, rgba(255,255,255,0.22) 0 1px, transparent 1.2px)",
          backgroundSize: "16px 16px",
        }}
      />
      <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(180deg,rgba(12,38,38,0.18),rgba(12,38,38,0.82)),radial-gradient(circle_at_top,rgba(24,90,99,0.38),transparent_54%),linear-gradient(135deg,rgba(8,26,28,0.44),rgba(8,26,28,0.8))] backdrop-blur-md" />

      <div className="relative z-10 flex h-full flex-col overflow-hidden">
      {showProxyChrome && (
        <div className="flex items-center gap-2 px-3 py-2 bg-gray-900 border-b border-gray-800 flex-shrink-0">
          <button
            onClick={handleHome}
            className="px-3 py-1.5 rounded-full bg-gray-800 hover:bg-gray-700 transition-colors text-sm text-gray-200"
            title="Back to home"
          >
            Home
          </button>

          <form onSubmit={handleSubmit} className="flex-1 flex items-center gap-2">
            <div className="flex-1 flex items-center bg-gray-800 rounded-full px-4 py-1.5 border border-gray-700 focus-within:border-blue-500 transition-colors">
              <svg
                className="w-3.5 h-3.5 text-gray-500 mr-2 flex-shrink-0"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <circle cx="11" cy="11" r="8" />
                <path d="m21 21-4.35-4.35" />
              </svg>
              <input
                type="text"
                value={urlInput}
                onChange={(e) => setUrlInput(e.target.value)}
                placeholder={currentUrl || "Search or enter URL..."}
                className="bg-transparent outline-none text-sm text-white placeholder-gray-500 flex-1"
              />
            </div>
            <button
              type="submit"
              className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 rounded-full text-sm font-medium transition-colors"
            >
              Go
            </button>
          </form>

          {loading && (
            <div className="w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin flex-shrink-0" />
          )}
        </div>
      )}

      {showYouTubeChrome && (
        <div className="flex items-center gap-3 px-4 py-3 bg-gray-900 border-b border-gray-800 flex-shrink-0">
          <button
            onClick={handleHome}
            className="px-3 py-1.5 rounded-full bg-gray-800 hover:bg-gray-700 transition-colors text-sm text-gray-200"
          >
            Home
          </button>
          <form onSubmit={handleYouTubeSearchSubmit} className="flex-1 flex items-center gap-2">
            <div className="flex-1 flex items-center bg-gray-800 rounded-full px-4 py-2 border border-gray-700 focus-within:border-red-500 transition-colors">
              <svg
                className="w-4 h-4 text-gray-500 mr-2 flex-shrink-0"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <circle cx="11" cy="11" r="8" />
                <path d="m21 21-4.35-4.35" />
              </svg>
              <input
                type="text"
                value={youtubeQuery}
                onChange={(e) => setYouTubeQuery(e.target.value)}
                placeholder="Search YouTube videos and playlists..."
                className="bg-transparent outline-none text-sm text-white placeholder-gray-500 flex-1"
              />
            </div>
            <button
              type="submit"
              disabled={youtubeLoading}
              className="px-4 py-2 bg-red-600 hover:bg-red-500 disabled:opacity-50 rounded-full text-sm font-medium transition-colors"
            >
              Search
            </button>
          </form>
        </div>
      )}

      {viewMode === "home" && (
        <div className="flex-1 flex flex-col items-center justify-center px-4 py-8 overflow-auto">
          <div className="w-full max-w-5xl">
            <div className="text-center mb-10">
              <h1 className="mb-2 text-4xl font-bold text-white drop-shadow-[0_6px_20px_rgba(0,0,0,0.45)]">
                SVMS Math Help
              </h1>
              <p className="text-sm text-teal-50/78">
                Proxy the web or switch to official YouTube mode
              </p>
            </div>

            {(!engineReady || !serviceWorkerControlled) && (
              <div className="flex items-center justify-center gap-2 text-gray-400 text-sm mb-6">
                <div className="w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
                <span>
                  {!engineReady
                    ? "Loading engine..."
                    : "Finishing proxy setup. Refresh once if this stays here."}
                </span>
              </div>
            )}

            <div className="grid gap-6 lg:grid-cols-[1.2fr_0.8fr]">
              <div className="rounded-3xl border border-white/12 bg-[rgba(7,16,19,0.68)] p-6 shadow-[0_30px_80px_rgba(0,0,0,0.35)] backdrop-blur-xl">
                <div className="mb-4">
                  <div className="text-xs uppercase tracking-[0.28em] text-blue-400">
                    Web Proxy
                  </div>
                  <h2 className="text-2xl font-semibold mt-2">
                    Browse regular sites
                  </h2>
                  <p className="mt-2 text-sm text-gray-300">
                    Search the web or open a URL through the Scramjet browser shell.
                  </p>
                </div>

                <form onSubmit={handleSubmit} className="w-full">
                  <div className="flex items-center gap-2 bg-gray-950 rounded-2xl p-2 border border-gray-800 focus-within:border-blue-500 transition-colors">
                    <svg
                      className="w-5 h-5 text-gray-500 ml-2 flex-shrink-0"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                    >
                      <circle cx="11" cy="11" r="8" />
                      <path d="m21 21-4.35-4.35" />
                    </svg>
                    <input
                      type="text"
                      value={urlInput}
                      onChange={(e) => setUrlInput(e.target.value)}
                      placeholder="Search the web or enter a URL..."
                      className="flex-1 bg-transparent outline-none text-white placeholder-gray-500 text-base px-2 py-2"
                      autoFocus
                      disabled={!engineReady || !serviceWorkerControlled}
                    />
                    <button
                      type="submit"
                      disabled={!engineReady || !serviceWorkerControlled || loading}
                      className="px-5 py-2.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed rounded-xl text-sm font-semibold transition-colors"
                    >
                      {loading ? "Loading..." : "Go"}
                    </button>
                  </div>
                </form>

                {error && (
                  <div className="mt-4 p-3 bg-red-900/30 border border-red-700 rounded-xl text-red-300 text-sm">
                    {error}
                  </div>
                )}

                <div className="mt-6 grid grid-cols-3 gap-3">
                  {[
                    {
                      label: "DuckDuckGo",
                      url: "https://duckduckgo.com",
                      tag: "search",
                    },
                    { label: "ESPN", url: "https://espn.com", tag: "sports" },
                    { label: "Wikipedia", url: "https://wikipedia.org", tag: "wiki" },
                  ].map(({ label, url, tag }) => (
                    <button
                      key={label}
                      onClick={() => {
                        setUrlInput(url);
                        void navigate(url);
                      }}
                      disabled={!engineReady || !serviceWorkerControlled}
                      className="flex items-center justify-between gap-2 px-4 py-3 bg-gray-950 hover:bg-gray-800 disabled:opacity-50 disabled:cursor-not-allowed rounded-xl border border-gray-800 hover:border-gray-700 text-sm text-gray-300 hover:text-white transition-all"
                    >
                      <span>{label}</span>
                      <span className="text-xs uppercase tracking-[0.2em] text-gray-500">
                        {tag}
                      </span>
                    </button>
                  ))}
                </div>
              </div>

              <div className="rounded-3xl border border-red-300/15 bg-[linear-gradient(180deg,rgba(74,15,25,0.76),rgba(10,14,17,0.78))] p-6 shadow-[0_30px_80px_rgba(0,0,0,0.4)] backdrop-blur-xl">
                <div className="mb-4">
                  <div className="text-xs uppercase tracking-[0.28em] text-red-400">
                    YouTube Mode
                  </div>
                  <h2 className="text-2xl font-semibold mt-2">
                    Watch without the full site UI
                  </h2>
                  <p className="text-sm text-gray-300 mt-2">
                    Search with the official YouTube Data API and watch through the official embedded player.
                  </p>
                </div>

                <form onSubmit={handleYouTubeSearchSubmit} className="space-y-3">
                  <div className="flex items-center gap-2 bg-black/30 rounded-2xl p-2 border border-red-900/30 focus-within:border-red-500 transition-colors">
                    <svg
                      className="w-5 h-5 text-red-300 ml-2 flex-shrink-0"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                    >
                      <circle cx="11" cy="11" r="8" />
                      <path d="m21 21-4.35-4.35" />
                    </svg>
                    <input
                      type="text"
                      value={youtubeQuery}
                      onChange={(e) => setYouTubeQuery(e.target.value)}
                      placeholder="Search YouTube or paste a YouTube link..."
                      className="flex-1 bg-transparent outline-none text-white placeholder:text-red-100/50 text-base px-2 py-2"
                    />
                  </div>
                  <div className="flex gap-3">
                    <button
                      type="submit"
                      disabled={youtubeLoading}
                      className="flex-1 px-5 py-2.5 bg-red-600 hover:bg-red-500 disabled:opacity-50 rounded-xl text-sm font-semibold transition-colors"
                    >
                      {youtubeLoading ? "Loading..." : "Open YouTube Mode"}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setYouTubeQuery("lofi hip hop");
                        void fetchYouTubeSearch("lofi hip hop");
                      }}
                      className="px-4 py-2.5 bg-white/10 hover:bg-white/15 rounded-xl text-sm font-medium transition-colors"
                    >
                      Try Demo
                    </button>
                  </div>
                </form>

                {youtubeError && (
                  <div className="mt-4 p-3 bg-red-900/30 border border-red-700 rounded-xl text-red-200 text-sm">
                    {youtubeError}
                  </div>
                )}

                <div className="mt-5 rounded-2xl bg-black/25 p-4 border border-white/10">
                  <div className="text-sm font-medium text-white mb-2">
                    How to use it
                  </div>
                  <div className="space-y-2 text-xs text-gray-300">
                    <p>1. Search for a video or playlist.</p>
                    <p>2. Pick a result to watch it inside the site.</p>
                    <p>3. Paste a normal YouTube link and it will open here too.</p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {viewMode === "youtube" && (
        <div className="flex-1 overflow-auto">
          <div className="mx-auto max-w-7xl px-4 py-6">
            <div className="grid gap-6 xl:grid-cols-[1.35fr_0.65fr]">
              <div className="space-y-4">
                <div className="aspect-video overflow-hidden rounded-3xl border border-gray-800 bg-black shadow-2xl">
                  {youtubeEmbedUrl ? (
                    <iframe
                      src={youtubeEmbedUrl}
                      title={youtubeSelected?.title ?? "YouTube player"}
                      allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                      allowFullScreen
                      className="h-full w-full border-0"
                      referrerPolicy="strict-origin-when-cross-origin"
                    />
                  ) : (
                    <div className="h-full w-full flex items-center justify-center text-gray-500 text-sm">
                      Search above to load a video or playlist.
                    </div>
                  )}
                </div>

                {youtubeSelected && (
                  <div className="rounded-3xl border border-white/10 bg-[rgba(7,16,19,0.72)] p-5 backdrop-blur-xl">
                    <div className="text-xs uppercase tracking-[0.24em] text-red-400">
                      {youtubeSelected.type}
                    </div>
                    <h2 className="mt-2 text-2xl font-semibold text-white">
                      {youtubeSelected.title}
                    </h2>
                    <div className="mt-2 text-sm text-gray-400">
                      {youtubeSelected.channelTitle} · {formatDate(youtubeSelected.publishedAt)}
                    </div>
                    {youtubeSelected.description && (
                      <p className="mt-4 text-sm leading-6 text-gray-300 whitespace-pre-wrap">
                        {youtubeSelected.description}
                      </p>
                    )}
                  </div>
                )}
              </div>

              <div className="space-y-4">
                <div className="rounded-3xl border border-white/10 bg-[rgba(7,16,19,0.72)] p-5 backdrop-blur-xl">
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="text-xs uppercase tracking-[0.24em] text-red-400">
                        Results
                      </div>
                      <div className="mt-2 text-lg font-semibold text-white">
                        {youtubeQuery ? `YouTube results for "${youtubeQuery}"` : "Search YouTube"}
                      </div>
                    </div>
                    {youtubeLoading && (
                      <div className="w-4 h-4 border-2 border-red-400 border-t-transparent rounded-full animate-spin" />
                    )}
                  </div>

                  {youtubeError && (
                    <div className="mt-4 rounded-xl border border-red-700 bg-red-900/20 px-4 py-3 text-sm text-red-200">
                      {youtubeError}
                    </div>
                  )}

                  <div className="mt-4 space-y-3">
                    {youtubeResults.length === 0 && !youtubeLoading && (
                      <div className="rounded-2xl border border-gray-800 bg-gray-950 px-4 py-6 text-center text-sm text-gray-500">
                        No results yet. Search above or paste a YouTube link into either search box.
                      </div>
                    )}

                    {youtubeResults.map((item) => (
                      <button
                        key={`${item.type}:${item.id}`}
                        onClick={() => openYouTubeResult(item)}
                        className="w-full rounded-2xl border border-gray-800 bg-gray-950 p-3 text-left transition-colors hover:border-red-500/50 hover:bg-gray-900"
                      >
                        <div className="flex gap-3">
                          {item.thumbnailUrl ? (
                            <img
                              src={item.thumbnailUrl}
                              alt={item.title}
                              className="h-20 w-36 rounded-xl object-cover bg-black"
                            />
                          ) : (
                            <div className="h-20 w-36 rounded-xl bg-gray-900" />
                          )}
                          <div className="min-w-0 flex-1">
                            <div className="text-xs uppercase tracking-[0.2em] text-red-400">
                              {item.type}
                            </div>
                            <div className="mt-1 line-clamp-2 text-sm font-medium text-white">
                              {item.title}
                            </div>
                            <div className="mt-2 text-xs text-gray-400">
                              {item.channelTitle}
                            </div>
                            <div className="mt-1 text-xs text-gray-500">
                              {formatDate(item.publishedAt)}
                            </div>
                          </div>
                        </div>
                      </button>
                    ))}
                  </div>

                  {youtubeNextPageToken && (
                    <button
                      type="button"
                      onClick={() => void fetchYouTubeSearch(youtubeQuery, youtubeNextPageToken)}
                      disabled={youtubeLoading}
                      className="mt-4 w-full rounded-xl bg-red-600 px-4 py-3 text-sm font-semibold text-white transition-colors hover:bg-red-500 disabled:opacity-50"
                    >
                      Load more
                    </button>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      <div
        ref={frameContainerRef}
        className="flex-1"
        style={{ display: viewMode === "proxy" ? "block" : "none" }}
      />
      </div>
    </div>
  );
}

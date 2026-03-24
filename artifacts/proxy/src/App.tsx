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

  interface Window {
    google?: {
      accounts: {
        id: {
          initialize(input: {
            client_id: string;
            callback: (response: { credential?: string }) => void;
          }): void;
          renderButton(
            parent: HTMLElement,
            options: Record<string, string | number>,
          ): void;
        };
      };
    };
  }
}

const PROXY_SCRIPT_URLS = ["/scram/scramjet.all.js", "/baremux/index.js"];
const GOOGLE_SCRIPT_URL = "https://accounts.google.com/gsi/client";

let proxyScriptsReadyPromise: Promise<void> | null = null;
let serviceWorkerReadyPromise: Promise<ServiceWorkerRegistration> | null = null;
let googleScriptsReadyPromise: Promise<void> | null = null;

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

function loadGoogleScript(): Promise<void> {
  if (!googleScriptsReadyPromise) {
    googleScriptsReadyPromise = ensureProxyScript(GOOGLE_SCRIPT_URL).catch(
      (error) => {
        googleScriptsReadyPromise = null;
        throw error;
      },
    );
  }

  return googleScriptsReadyPromise;
}

type AuthUser = {
  email: string;
  name: string;
  picture?: string;
};

type AuthSessionResponse = {
  googleClientId: string | null;
  sessionConfigured: boolean;
  user: AuthUser | null;
};

function toYouTubeEmbedUrl(input: string): string | null {
  let url: URL;

  try {
    url = new URL(input);
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
    const embedUrl = new URL(`https://www.youtube.com/embed/${videoId}`);
    if (playlistId) {
      embedUrl.searchParams.set("list", playlistId);
    }
    if (index) {
      embedUrl.searchParams.set("index", index);
    }
    return embedUrl.toString();
  }

  if (playlistId) {
    const embedUrl = new URL("https://www.youtube.com/embed/videoseries");
    embedUrl.searchParams.set("list", playlistId);
    if (index) {
      embedUrl.searchParams.set("index", index);
    }
    return embedUrl.toString();
  }

  return null;
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
  const [browsing, setBrowsing] = useState(false);
  const [currentUrl, setCurrentUrl] = useState("");
  const [engineReady, setEngineReady] = useState(false);
  const [authUser, setAuthUser] = useState<AuthUser | null>(null);
  const [googleClientId, setGoogleClientId] = useState<string | null>(null);
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState("");
  const [youtubeEmbedUrl, setYouTubeEmbedUrl] = useState<string | null>(null);

  const frameContainerRef = useRef<HTMLDivElement>(null);
  const googleButtonRef = useRef<HTMLDivElement>(null);
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
    let cancelled = false;

    void fetch("/api/auth/session", {
      credentials: "include",
    })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error("Failed to load sign-in state.");
        }

        return (await response.json()) as AuthSessionResponse;
      })
      .then((session) => {
        if (cancelled) {
          return;
        }

        setGoogleClientId(session.googleClientId);
        setAuthUser(session.user);

        if (!session.sessionConfigured && session.googleClientId) {
          setAuthError("Google sign-in is configured, but session signing is missing.");
        }
      })
      .catch((cause: unknown) => {
        if (cancelled) {
          return;
        }

        setAuthError(
          cause instanceof Error ? cause.message : "Failed to load sign-in state.",
        );
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const completeGoogleSignIn = useCallback(async (credential?: string) => {
    if (!credential) {
      setAuthError("Google sign-in did not return a credential.");
      return;
    }

    setAuthBusy(true);
    setAuthError("");

    try {
      const response = await fetch("/api/auth/google", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        credentials: "include",
        body: JSON.stringify({ credential }),
      });

      const data = (await response.json()) as {
        error?: string;
        user?: AuthUser;
      };

      if (!response.ok || !data.user) {
        throw new Error(data.error ?? "Google sign-in failed.");
      }

      setAuthUser(data.user);
    } catch (cause) {
      setAuthError(
        cause instanceof Error ? cause.message : "Google sign-in failed.",
      );
    } finally {
      setAuthBusy(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    if (!googleClientId || !googleButtonRef.current || authUser) {
      return;
    }

    void loadGoogleScript()
      .then(() => {
        if (cancelled || !window.google || !googleButtonRef.current) {
          return;
        }

        googleButtonRef.current.innerHTML = "";
        window.google.accounts.id.initialize({
          client_id: googleClientId,
          callback: (response) => {
            void completeGoogleSignIn(response.credential);
          },
        });
        window.google.accounts.id.renderButton(googleButtonRef.current, {
          theme: "outline",
          size: "large",
          shape: "pill",
          text: "signin_with",
          width: 260,
        });
      })
      .catch((cause: unknown) => {
        if (cancelled) {
          return;
        }

        setAuthError(
          cause instanceof Error
            ? cause.message
            : "Failed to load Google sign-in.",
        );
      });

    return () => {
      cancelled = true;
    };
  }, [authUser, completeGoogleSignIn, googleClientId]);

  const handleLogout = useCallback(async () => {
    setAuthBusy(true);
    setAuthError("");

    try {
      const response = await fetch("/api/auth/logout", {
        method: "POST",
        credentials: "include",
      });

      if (!response.ok) {
        throw new Error("Failed to sign out.");
      }

      setAuthUser(null);
    } catch (cause) {
      setAuthError(cause instanceof Error ? cause.message : "Failed to sign out.");
    } finally {
      setAuthBusy(false);
    }
  }, []);

  const navigate = useCallback(async (targetUrl: string) => {
    if (!targetUrl.trim()) {
      return;
    }

    setError("");
    setLoading(true);

    try {
      const resolved = searchToUrl(targetUrl, "https://duckduckgo.com/?q=%s");
      const youtubeUrl = toYouTubeEmbedUrl(resolved);

      if (youtubeUrl) {
        setYouTubeEmbedUrl(youtubeUrl);
        setCurrentUrl(resolved);
        setUrlInput(resolved);
        setBrowsing(true);
        return;
      }

      await registerServiceWorker();
      setYouTubeEmbedUrl(null);

      if (!controllerRef.current || !connectionRef.current) {
        throw new Error("Engine not ready. Refresh the page and try again.");
      }

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
      setBrowsing(true);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Navigation failed. Try refreshing the page.",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    void navigate(urlInput);
  };

  const handleHome = () => {
    setBrowsing(false);
    setCurrentUrl("");
    setUrlInput("");
    setError("");
    setYouTubeEmbedUrl(null);
    frameRef.current = null;
    transportConfiguredRef.current = false;

    if (frameContainerRef.current) {
      frameContainerRef.current.innerHTML = "";
    }
  };

  return (
    <div className="h-screen bg-gray-950 text-white flex flex-col overflow-hidden">
      {browsing && (
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

      {!browsing && (
        <div className="flex-1 flex flex-col items-center justify-center px-4">
          <div className="w-full max-w-2xl">
            <div className="text-center mb-8">
              <h1 className="text-3xl font-bold text-white mb-1">
                SVMS Math Help
              </h1>
              <p className="text-gray-400 text-sm">We all know who made it</p>
            </div>

            <div className="mb-6 rounded-2xl border border-gray-800 bg-gray-900/70 p-4">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <div className="text-sm font-medium text-white">
                    Google sign-in for this site
                  </div>
                  <div className="text-xs text-gray-400">
                    This uses official Google OAuth on the website, not inside the proxy frame.
                  </div>
                </div>

                {authUser ? (
                  <div className="flex items-center gap-3">
                    {authUser.picture ? (
                      <img
                        src={authUser.picture}
                        alt={authUser.name}
                        className="h-10 w-10 rounded-full border border-gray-700 object-cover"
                      />
                    ) : null}
                    <div className="text-right">
                      <div className="text-sm font-medium text-white">
                        {authUser.name}
                      </div>
                      <div className="text-xs text-gray-400">{authUser.email}</div>
                    </div>
                    <button
                      type="button"
                      onClick={() => void handleLogout()}
                      disabled={authBusy}
                      className="rounded-full bg-gray-800 px-4 py-2 text-sm text-gray-100 transition-colors hover:bg-gray-700 disabled:opacity-50"
                    >
                      Sign out
                    </button>
                  </div>
                ) : googleClientId ? (
                  <div className="flex min-h-10 items-center justify-end">
                    <div ref={googleButtonRef} />
                  </div>
                ) : (
                  <div className="text-xs text-gray-500">
                    Set `GOOGLE_CLIENT_ID` on the server to enable sign-in.
                  </div>
                )}
              </div>

              {(authError || authBusy) && (
                <div className="mt-3 text-xs text-gray-400">
                  {authBusy ? "Working..." : authError}
                </div>
              )}
            </div>

            {!engineReady && (
              <div className="flex items-center justify-center gap-2 text-gray-400 text-sm mb-6">
                <div className="w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
                <span>Loading engine...</span>
              </div>
            )}

            <form onSubmit={handleSubmit} className="w-full">
              <div className="flex items-center gap-2 bg-gray-900 rounded-2xl p-2 border border-gray-800 focus-within:border-blue-500 transition-colors shadow-xl">
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
                  disabled={!engineReady}
                />
                <button
                  type="submit"
                  disabled={!engineReady || loading}
                  className="px-5 py-2.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed rounded-xl text-sm font-semibold transition-colors"
                >
                  {loading ? (
                    <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  ) : (
                    "Go"
                  )}
                </button>
              </div>
            </form>

            {error && (
              <div className="mt-4 p-3 bg-red-900/30 border border-red-700 rounded-xl text-red-300 text-sm">
                {error}
              </div>
            )}

            <div className="mt-8 grid grid-cols-3 gap-3">
              {[
                {
                  label: "DuckDuckGo",
                  url: "https://duckduckgo.com",
                  tag: "search",
                },
                { label: "ESPN", url: "https://espn.com", tag: "sports" },
                { label: "YouTube", url: "https://youtube.com", tag: "video" },
              ].map(({ label, url, tag }) => (
                <button
                  key={label}
                  onClick={() => {
                    setUrlInput(url);
                    void navigate(url);
                  }}
                  disabled={!engineReady}
                  className="flex items-center justify-between gap-2 px-4 py-3 bg-gray-900 hover:bg-gray-800 disabled:opacity-50 disabled:cursor-not-allowed rounded-xl border border-gray-800 hover:border-gray-700 text-sm text-gray-300 hover:text-white transition-all"
                >
                  <span>{label}</span>
                  <span className="text-xs uppercase tracking-[0.2em] text-gray-500">
                    {tag}
                  </span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      <div className="flex-1" style={{ display: browsing ? "block" : "none" }}>
        {youtubeEmbedUrl ? (
          <div className="h-full w-full bg-black">
            <iframe
              src={youtubeEmbedUrl}
              title="YouTube player"
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
              allowFullScreen
              className="h-full w-full border-0"
              referrerPolicy="strict-origin-when-cross-origin"
            />
          </div>
        ) : (
          <div ref={frameContainerRef} className="h-full w-full" />
        )}
      </div>
    </div>
  );
}

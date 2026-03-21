import { useState, useRef, useEffect, useCallback } from "react";

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

function search(input: string, template: string): string {
  try {
    return new URL(input).toString();
  } catch {}
  try {
    const url = new URL(`http://${input}`);
    if (url.hostname.includes(".")) return url.toString();
  } catch {}
  return template.replace("%s", encodeURIComponent(input));
}

async function registerServiceWorker() {
  if (!navigator.serviceWorker) {
    if (location.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(location.hostname)) {
      throw new Error("Service workers require HTTPS.");
    }
    throw new Error("Your browser does not support service workers.");
  }
  await navigator.serviceWorker.register("/sw.js");
  await navigator.serviceWorker.ready;
}

export default function App() {
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  const [currentUrl, setCurrentUrl] = useState("");
  const [swReady, setSwReady] = useState(false);
  const frameContainerRef = useRef<HTMLDivElement>(null);
  const scramjetRef = useRef<ReturnType<ReturnType<typeof $scramjetLoadController>["ScramjetController"]["prototype"]["createFrame"]> | null>(null);
  const connectionRef = useRef<InstanceType<typeof BareMux.BareMuxConnection> | null>(null);
  const controllerRef = useRef<{ init(): void; createFrame(): { frame: HTMLIFrameElement; go(url: string): void } } | null>(null);

  useEffect(() => {
    const scriptUrls = ["/scram/scramjet.all.js", "/baremux/index.js"];
    let loaded = 0;

    const onAllLoaded = () => {
      try {
        const { ScramjetController } = $scramjetLoadController();
        controllerRef.current = new ScramjetController({
          files: {
            wasm: "/scram/scramjet.wasm.wasm",
            all: "/scram/scramjet.all.js",
            sync: "/scram/scramjet.sync.js",
          },
        });
        controllerRef.current.init();
        connectionRef.current = new BareMux.BareMuxConnection("/baremux/worker.js");
        setSwReady(true);
      } catch (e) {
        console.error("Failed to initialize Scramjet", e);
        setError("Failed to initialize proxy engine.");
      }
    };

    scriptUrls.forEach((src) => {
      const script = document.createElement("script");
      script.src = src;
      script.onload = () => {
        loaded++;
        if (loaded === scriptUrls.length) onAllLoaded();
      };
      script.onerror = () => {
        setError(`Failed to load proxy script: ${src}`);
      };
      document.head.appendChild(script);
    });
  }, []);

  const handleNavigate = useCallback(
    async (targetUrl: string) => {
      if (!targetUrl.trim()) return;
      setError("");
      setLoading(true);

      try {
        await registerServiceWorker();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Service worker registration failed.");
        setLoading(false);
        return;
      }

      if (!controllerRef.current || !connectionRef.current) {
        setError("Proxy engine not ready. Please refresh the page.");
        setLoading(false);
        return;
      }

      const resolved = search(targetUrl, "https://www.google.com/search?q=%s");

      const wispUrl =
        (location.protocol === "https:" ? "wss" : "ws") +
        "://" +
        location.host +
        "/wisp/";

      try {
        const transport = await connectionRef.current.getTransport();
        if (transport !== "/libcurl/index.mjs") {
          await connectionRef.current.setTransport("/libcurl/index.mjs", [
            { websocket: wispUrl },
          ]);
        }
      } catch (e) {
        setError("Failed to configure transport: " + (e instanceof Error ? e.message : String(e)));
        setLoading(false);
        return;
      }

      if (!browsing) {
        const frame = controllerRef.current.createFrame();
        frame.frame.style.width = "100%";
        frame.frame.style.height = "100%";
        frame.frame.style.border = "none";
        frame.frame.id = "sj-frame";
        scramjetRef.current = frame;
        if (frameContainerRef.current) {
          frameContainerRef.current.innerHTML = "";
          frameContainerRef.current.appendChild(frame.frame);
        }
        setBrowsing(true);
        frame.go(resolved);
      } else {
        scramjetRef.current?.go(resolved);
      }

      setCurrentUrl(resolved);
      setLoading(false);
    },
    [browsing],
  );

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    handleNavigate(url);
  };

  const handleBack = () => {
    setBrowsing(false);
    setCurrentUrl("");
    scramjetRef.current = null;
    if (frameContainerRef.current) {
      frameContainerRef.current.innerHTML = "";
    }
  };

  return (
    <div className="min-h-screen bg-gray-950 text-white flex flex-col">
      {browsing ? (
        <>
          <div className="flex items-center gap-2 px-3 py-2 bg-gray-900 border-b border-gray-800">
            <button
              onClick={handleBack}
              className="p-1.5 rounded hover:bg-gray-700 transition-colors text-gray-400 hover:text-white"
              title="Back to home"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M19 12H5M12 19l-7-7 7-7" />
              </svg>
            </button>

            <form onSubmit={handleSubmit} className="flex-1 flex items-center gap-2">
              <div className="flex-1 flex items-center bg-gray-800 rounded-full px-4 py-1.5 border border-gray-700 focus-within:border-blue-500 transition-colors">
                <svg className="w-3.5 h-3.5 text-gray-500 mr-2 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="11" cy="11" r="8" />
                  <path d="m21 21-4.35-4.35" />
                </svg>
                <input
                  type="text"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="Search or enter URL..."
                  className="bg-transparent outline-none text-sm text-white placeholder-gray-500 flex-1"
                  onFocus={(e) => { e.target.value = currentUrl; setUrl(currentUrl); }}
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
              <div className="w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
            )}
          </div>

          <div ref={frameContainerRef} className="flex-1" />
        </>
      ) : (
        <div className="flex-1 flex flex-col items-center justify-center px-4">
          <div className="w-full max-w-2xl">
            <div className="text-center mb-8">
              <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-gradient-to-br from-blue-600 to-purple-600 mb-4 shadow-lg shadow-blue-500/20">
                <svg className="w-8 h-8 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="12" cy="12" r="10" />
                  <path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
                </svg>
              </div>
              <h1 className="text-3xl font-bold text-white mb-1">Scramjet Proxy</h1>
              <p className="text-gray-400 text-sm">Browse freely, privately, without restrictions</p>
            </div>

            {!swReady && (
              <div className="flex items-center justify-center gap-2 text-gray-400 text-sm mb-6">
                <div className="w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
                <span>Loading proxy engine...</span>
              </div>
            )}

            <form onSubmit={handleSubmit} className="w-full">
              <div className="flex items-center gap-2 bg-gray-900 rounded-2xl p-2 border border-gray-800 focus-within:border-blue-500 transition-colors shadow-xl">
                <svg className="w-5 h-5 text-gray-500 ml-2 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="11" cy="11" r="8" />
                  <path d="m21 21-4.35-4.35" />
                </svg>
                <input
                  type="text"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="Search the web or enter a URL..."
                  className="flex-1 bg-transparent outline-none text-white placeholder-gray-500 text-base px-2 py-2"
                  autoFocus
                  disabled={!swReady}
                />
                <button
                  type="submit"
                  disabled={!swReady || loading}
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
                { label: "Google", url: "https://google.com", icon: "🔍" },
                { label: "YouTube", url: "https://youtube.com", icon: "▶️" },
                { label: "Reddit", url: "https://reddit.com", icon: "🔴" },
                { label: "Twitter", url: "https://twitter.com", icon: "🐦" },
                { label: "Wikipedia", url: "https://wikipedia.org", icon: "📖" },
                { label: "GitHub", url: "https://github.com", icon: "🐙" },
              ].map(({ label, url: shortcutUrl, icon }) => (
                <button
                  key={label}
                  onClick={() => { setUrl(shortcutUrl); handleNavigate(shortcutUrl); }}
                  disabled={!swReady}
                  className="flex items-center gap-2 px-4 py-3 bg-gray-900 hover:bg-gray-800 disabled:opacity-50 disabled:cursor-not-allowed rounded-xl border border-gray-800 hover:border-gray-700 text-sm text-gray-300 hover:text-white transition-all"
                >
                  <span>{icon}</span>
                  <span>{label}</span>
                </button>
              ))}
            </div>

            <p className="text-center text-gray-600 text-xs mt-8">
              Powered by{" "}
              <a
                href="https://github.com/MercuryWorkshop/scramjet"
                target="_blank"
                rel="noopener noreferrer"
                className="text-gray-500 hover:text-gray-400"
              >
                Scramjet
              </a>{" "}
              by Mercury Workshop
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

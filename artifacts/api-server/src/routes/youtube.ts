import { Router, type IRouter } from "express";

const router: IRouter = Router();

const YOUTUBE_API_BASE = "https://www.googleapis.com/youtube/v3";
const DEFAULT_RESULTS = 12;

type SearchResultItem = {
  id: { kind: string; videoId?: string; playlistId?: string };
  snippet: {
    title: string;
    description: string;
    channelTitle: string;
    publishedAt: string;
    thumbnails?: Record<string, { url: string; width?: number; height?: number }>;
  };
};

function getApiKey(): string | null {
  return process.env["YOUTUBE_API_KEY"] ?? null;
}

function getBestThumbnail(
  thumbnails: Record<string, { url: string }> | undefined,
): string | null {
  if (!thumbnails) {
    return null;
  }

  return (
    thumbnails["high"]?.url ??
    thumbnails["medium"]?.url ??
    thumbnails["default"]?.url ??
    null
  );
}

async function youtubeFetch(
  endpoint: string,
  params: Record<string, string>,
): Promise<unknown> {
  const apiKey = getApiKey();
  if (!apiKey) {
    throw new Error("YouTube API key is not configured.");
  }

  const url = new URL(`${YOUTUBE_API_BASE}/${endpoint}`);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  url.searchParams.set("key", apiKey);

  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
    },
  });

  const data = (await response.json()) as { error?: { message?: string } };
  if (!response.ok) {
    throw new Error(data.error?.message ?? "YouTube API request failed.");
  }

  return data;
}

router.get("/youtube/search", async (req, res) => {
  const query = String(req.query["q"] ?? "").trim();
  const pageToken = String(req.query["pageToken"] ?? "").trim();

  if (!query) {
    res.status(400).json({ error: "Missing YouTube search query." });
    return;
  }

  try {
    const data = (await youtubeFetch("search", {
      part: "snippet",
      q: query,
      type: "video,playlist",
      maxResults: String(DEFAULT_RESULTS),
      safeSearch: "moderate",
      ...(pageToken ? { pageToken } : {}),
    })) as {
      nextPageToken?: string;
      items?: SearchResultItem[];
    };

    const items = (data.items ?? [])
      .map((item) => {
        const kind = item.id.kind;
        const type = kind.endsWith("#playlist") ? "playlist" : "video";
        const id =
          type === "playlist" ? item.id.playlistId ?? "" : item.id.videoId ?? "";
        if (!id) {
          return null;
        }

        return {
          id,
          type,
          title: item.snippet.title,
          description: item.snippet.description,
          channelTitle: item.snippet.channelTitle,
          publishedAt: item.snippet.publishedAt,
          thumbnailUrl: getBestThumbnail(item.snippet.thumbnails),
        };
      })
      .filter(Boolean);

    res.setHeader("Cache-Control", "no-store");
    res.json({
      query,
      nextPageToken: data.nextPageToken ?? null,
      items,
    });
  } catch (error) {
    res.status(502).json({
      error:
        error instanceof Error ? error.message : "YouTube search request failed.",
    });
  }
});

router.get("/youtube/lookup", async (req, res) => {
  const videoId = String(req.query["videoId"] ?? "").trim();
  const playlistId = String(req.query["playlistId"] ?? "").trim();

  if (!videoId && !playlistId) {
    res.status(400).json({ error: "Missing YouTube videoId or playlistId." });
    return;
  }

  try {
    if (videoId) {
      const data = (await youtubeFetch("videos", {
        part: "snippet",
        id: videoId,
        maxResults: "1",
      })) as {
        items?: Array<{
          id: string;
          snippet: SearchResultItem["snippet"];
        }>;
      };

      const item = data.items?.[0];
      if (!item) {
        res.status(404).json({ error: "Video not found." });
        return;
      }

      res.setHeader("Cache-Control", "no-store");
      res.json({
        item: {
          id: item.id,
          type: "video",
          title: item.snippet.title,
          description: item.snippet.description,
          channelTitle: item.snippet.channelTitle,
          publishedAt: item.snippet.publishedAt,
          thumbnailUrl: getBestThumbnail(item.snippet.thumbnails),
        },
      });
      return;
    }

    const data = (await youtubeFetch("playlists", {
      part: "snippet",
      id: playlistId,
      maxResults: "1",
    })) as {
      items?: Array<{
        id: string;
        snippet: SearchResultItem["snippet"];
      }>;
    };

    const item = data.items?.[0];
    if (!item) {
      res.status(404).json({ error: "Playlist not found." });
      return;
    }

    res.setHeader("Cache-Control", "no-store");
    res.json({
      item: {
        id: item.id,
        type: "playlist",
        title: item.snippet.title,
        description: item.snippet.description,
        channelTitle: item.snippet.channelTitle,
        publishedAt: item.snippet.publishedAt,
        thumbnailUrl: getBestThumbnail(item.snippet.thumbnails),
      },
    });
  } catch (error) {
    res.status(502).json({
      error:
        error instanceof Error ? error.message : "YouTube lookup request failed.",
    });
  }
});

export default router;

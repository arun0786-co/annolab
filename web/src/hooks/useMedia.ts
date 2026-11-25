import { useEffect, useState } from "react";
import { api } from "../api/client";

const cache = new Map<number, Promise<string>>();

/** Object URL for an item's media, fetched with the auth header and cached for the session. */
export function mediaUrl(itemId: number): Promise<string> {
  let p = cache.get(itemId);
  if (!p) {
    p = api.mediaBlob(itemId).then((b) => URL.createObjectURL(b));
    p.catch(() => cache.delete(itemId));
    cache.set(itemId, p);
  }
  return p;
}

export function useMedia(itemId: number | null | undefined) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<Error | null>(null);
  useEffect(() => {
    setUrl(null);
    setError(null);
    if (itemId == null) return;
    let live = true;
    mediaUrl(itemId).then(
      (u) => live && setUrl(u),
      (e) => live && setError(e),
    );
    return () => {
      live = false;
    };
  }, [itemId]);
  return { url, error };
}

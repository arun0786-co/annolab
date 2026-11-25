import { useMemo } from "react";
import { api } from "../api/client";

/** Streaming URL for an item's media (supports Range requests for audio and video). */
export function useMedia(itemId: number | null | undefined) {
  const url = useMemo(() => (itemId == null ? null : api.mediaSrc(itemId)), [itemId]);
  return { url, error: null as Error | null };
}

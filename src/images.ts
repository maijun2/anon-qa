import { errorJson, json } from "./http";
import type { Env, SessionRow } from "./types";

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

function r2Key(sessionId: string, imageId: string): string {
  return `${sessionId}/${imageId}`;
}

export async function uploadImage(request: Request, env: Env, session: SessionRow): Promise<Response> {
  let file: unknown;
  try {
    file = (await request.formData()).get("file");
  } catch {
    return errorJson("multipart/form-data で file を送信してください", 400);
  }
  if (!(file instanceof File)) return errorJson("multipart/form-data で file を送信してください", 400);
  if (!file.type.startsWith("image/")) return errorJson("画像ファイル(image/*)のみアップロードできます", 400);
  if (file.size > MAX_IMAGE_BYTES) return errorJson("画像は 1 枚 5MB 以下にしてください", 413);

  const imageId = crypto.randomUUID();
  await env.IMAGES.put(r2Key(session.id, imageId), await file.arrayBuffer(), {
    httpMetadata: { contentType: file.type },
  });
  return json({ imageKey: imageId });
}

export async function getImage(env: Env, session: SessionRow, imageId: string): Promise<Response> {
  const obj = await env.IMAGES.get(r2Key(session.id, imageId));
  if (!obj) return errorJson("画像が見つかりません", 404);
  return new Response(obj.body, {
    headers: {
      "Content-Type": obj.httpMetadata?.contentType ?? "application/octet-stream",
      "Cache-Control": "private, max-age=3600",
    },
  });
}

export async function deleteImage(env: Env, sessionId: string, imageId: string | null): Promise<void> {
  if (imageId) await env.IMAGES.delete(r2Key(sessionId, imageId));
}

export async function deleteSessionImages(env: Env, sessionId: string): Promise<void> {
  let cursor: string | undefined;
  do {
    const listed = await env.IMAGES.list({ prefix: `${sessionId}/`, cursor });
    if (listed.objects.length > 0) {
      await env.IMAGES.delete(listed.objects.map((o) => o.key));
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
}

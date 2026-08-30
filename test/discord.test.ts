// notifyNewQuestion(Discord Webhook 通知)の単体テスト:
//   * DISCORD_WEBHOOK_URL 未設定時は fetch を呼ばない(機能無効化)
//   * 設定時のペイロード形式・thread_id クエリ付与
//   * 200 文字超の切り詰め・画像ありマーカー
//   * 送信失敗(non-2xx / 例外)時も呼び出し元へは一切伝播しない(fire-and-forget)
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { notifyNewQuestion } from "../src/discord";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("notifyNewQuestion", () => {
  it("DISCORD_WEBHOOK_URL 未設定なら fetch を呼ばない", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    // env には DISCORD_WEBHOOK_URL を設定していない(テストバインディングの既定)
    await notifyNewQuestion(env, { sessionName: "S", questionId: "q1", text: "本文", hasImage: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("設定時は指定フォーマットで送信し、thread_id をクエリに付与する", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const testEnv = { ...env, DISCORD_WEBHOOK_URL: "https://discord.example.com/api/webhooks/123/abc", DISCORD_THREAD_ID: "999" };

    await notifyNewQuestion(testEnv, {
      sessionName: "DataLakeOnAWS Day1",
      questionId: "q-1",
      text: "S3のバージョニングについて",
      hasImage: false,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(calledUrl).toBe("https://discord.example.com/api/webhooks/123/abc?thread_id=999");
    expect(init.method).toBe("POST");
    const payload = JSON.parse(init.body as string) as { content: string };
    expect(payload.content).toContain("📨 新規質問 (セッション: DataLakeOnAWS Day1, ID: q-1)");
    expect(payload.content).toContain("S3のバージョニングについて");
    expect(payload.content).not.toContain("画像あり");
  });

  it("thread_id 未設定ならクエリを付与しない", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const testEnv = { ...env, DISCORD_WEBHOOK_URL: "https://discord.example.com/api/webhooks/123/abc" };

    await notifyNewQuestion(testEnv, { sessionName: "S", questionId: "q1", text: "本文", hasImage: false });

    const [calledUrl] = fetchMock.mock.calls[0] as [string];
    expect(calledUrl).toBe("https://discord.example.com/api/webhooks/123/abc");
  });

  it("200文字を超える本文は末尾を ... で切り詰める", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const testEnv = { ...env, DISCORD_WEBHOOK_URL: "https://discord.example.com/api/webhooks/123/abc" };
    const longText = "あ".repeat(250);

    await notifyNewQuestion(testEnv, { sessionName: "S", questionId: "q1", text: longText, hasImage: false });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const payload = JSON.parse(init.body as string) as { content: string };
    expect(payload.content).toContain(`${"あ".repeat(200)}...`);
    expect(payload.content).not.toContain("あ".repeat(201));
  });

  it("画像ありの場合は📎画像ありを追記する", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const testEnv = { ...env, DISCORD_WEBHOOK_URL: "https://discord.example.com/api/webhooks/123/abc" };

    await notifyNewQuestion(testEnv, { sessionName: "S", questionId: "q1", text: "本文", hasImage: true });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const payload = JSON.parse(init.body as string) as { content: string };
    expect(payload.content).toContain("📎画像あり");
  });

  it("fetch が例外を投げても notifyNewQuestion 自体は例外を投げない", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("network error")),
    );
    const testEnv = { ...env, DISCORD_WEBHOOK_URL: "https://discord.example.com/api/webhooks/123/abc" };

    await expect(
      notifyNewQuestion(testEnv, { sessionName: "S", questionId: "q1", text: "本文", hasImage: false }),
    ).resolves.toBeUndefined();
  });

  it("Discord が非 2xx を返しても例外を投げない", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("bad", { status: 500 })));
    const testEnv = { ...env, DISCORD_WEBHOOK_URL: "https://discord.example.com/api/webhooks/123/abc" };

    await expect(
      notifyNewQuestion(testEnv, { sessionName: "S", questionId: "q1", text: "本文", hasImage: false }),
    ).resolves.toBeUndefined();
  });
});

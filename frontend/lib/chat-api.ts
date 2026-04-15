// Helpers — call Python chat API.

export type ChatMessage = { role: "user" | "model"; content: string };

const baseUrl = () =>
  (process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:8000").replace(
    /\/$/,
    "",
  );

export async function sendChat(
  messages: ChatMessage[],
  locale: string,
): Promise<string> {
  const res = await fetch(`${baseUrl()}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages, locale }),
  });
  const text = await res.text();
  if (!res.ok) {
    let detail = text;
    try {
      const j = JSON.parse(text) as { detail?: string };
      if (j.detail) detail = j.detail;
    } catch {
      /* use raw */
    }
    throw new Error(detail || `HTTP ${res.status}`);
  }
  const data = JSON.parse(text) as { reply: string };
  return data.reply;
}

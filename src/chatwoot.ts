import { env } from "./config.js";

export type ChatwootMessage = {
  id: number;
  content: string | null;
  message_type: number | string; // API returns 0/1/2/3, webhooks return "incoming"/"outgoing"/...
  private: boolean;
  created_at: number;
};

export class ChatwootError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function call(method: string, path: string, body?: unknown, token = env.botToken): Promise<any> {
  const url = `${env.chatwootUrl}/api/v1${path}`;
  if (env.dryRun) {
    console.log(`[DRY_RUN] ${method} ${path}${body ? " " + JSON.stringify(body) : ""}`);
    return method === "GET" ? { payload: [] } : {};
  }
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json", api_access_token: token },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new ChatwootError(res.status, `${method} ${path} -> ${res.status} ${await res.text()}`);
  return res.json().catch(() => ({}));
}

const conv = (accountId: number, conversationId: number) =>
  `/accounts/${accountId}/conversations/${conversationId}`;

export const chatwoot = {
  sendMessage(accountId: number, conversationId: number, content: string) {
    return call("POST", `${conv(accountId, conversationId)}/messages`, {
      content,
      message_type: "outgoing",
      private: false,
    });
  },

  privateNote(accountId: number, conversationId: number, content: string) {
    return call("POST", `${conv(accountId, conversationId)}/messages`, {
      content,
      message_type: "outgoing",
      private: true,
    });
  },

  toggleStatus(accountId: number, conversationId: number, status: "open" | "resolved" | "pending") {
    return call("POST", `${conv(accountId, conversationId)}/toggle_status`, { status });
  },

  /** Note: Chatwoot replaces the full label list, so pass existing labels too. Never throws. */
  async addLabels(accountId: number, conversationId: number, labels: string[]) {
    const path = `${conv(accountId, conversationId)}/labels`;
    try {
      return await call("POST", path, { labels });
    } catch (err) {
      if (err instanceof ChatwootError && (err.status === 401 || err.status === 403) && env.userToken) {
        return call("POST", path, { labels }, env.userToken).catch((e) => console.warn("labels skipped:", e.message));
      }
      console.warn("labels skipped:", (err as Error).message);
    }
  },

  async getMessages(accountId: number, conversationId: number): Promise<ChatwootMessage[]> {
    const data = await call("GET", `${conv(accountId, conversationId)}/messages`);
    return (data?.payload ?? []) as ChatwootMessage[];
  },
};

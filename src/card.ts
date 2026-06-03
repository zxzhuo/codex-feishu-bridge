export interface CardMetrics {
  sessionId?: string;
  project?: string;
  cwd?: string;
  elapsedMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
}

function formatElapsed(ms: number): string {
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

function shortId(id?: string): string | undefined {
  if (!id) return undefined;
  return id.length > 12 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id;
}

export function sanitizeMarkdown(text: string, maxChars: number): string {
  let s = text.replace(/\r\n/g, "\n");
  if (s.length > maxChars) s = `${s.slice(0, maxChars)}\n\n*(内容过长，已截断)*`;
  const fences = s.match(/```/g)?.length ?? 0;
  if (fences % 2 !== 0) s += "\n```";
  return s || "…";
}

export function buildCard(opts: {
  title: string;
  template: "blue" | "green" | "red" | "yellow" | "grey";
  text: string;
  status?: string;
  metrics?: CardMetrics;
  maxChars: number;
}): Record<string, unknown> {
  const footer: string[] = [];
  if (opts.metrics?.elapsedMs !== undefined) footer.push(`⚡ ${formatElapsed(opts.metrics.elapsedMs)}`);
  if (opts.metrics?.project) footer.push(`📁 ${opts.metrics.project}`);
  if (opts.metrics?.sessionId) footer.push(`🧵 ${shortId(opts.metrics.sessionId)}`);
  if (opts.metrics?.inputTokens !== undefined || opts.metrics?.outputTokens !== undefined) {
    footer.push(`📊 ${opts.metrics.inputTokens ?? 0} → ${opts.metrics.outputTokens ?? 0}`);
  }
  if (opts.status) footer.push(opts.status);

  return {
    header: {
      title: { tag: "plain_text", content: opts.title },
      template: opts.template,
    },
    elements: [
      { tag: "markdown", content: sanitizeMarkdown(opts.text, opts.maxChars) },
      ...(footer.length > 0 ? [{ tag: "hr" }, { tag: "markdown", content: footer.join("  ·  ") }] : []),
    ],
  };
}

async function createMessage(client: any, chatId: string, msgType: string, content: string): Promise<string | null> {
  const api = client.im?.message ?? client.im?.v1?.message;
  const res = await api.create({
    params: { receive_id_type: "chat_id" },
    data: { receive_id: chatId, msg_type: msgType, content },
  });
  return res?.data?.message_id ?? null;
}

async function patchMessage(client: any, messageId: string, msgType: string, content: string): Promise<void> {
  const api = client.im?.message ?? client.im?.v1?.message;
  await api.patch({ path: { message_id: messageId }, data: { msg_type: msgType, content } });
}

export async function sendText(client: any, chatId: string, text: string): Promise<string | null> {
  return createMessage(client, chatId, "text", JSON.stringify({ text }));
}

export class CardController {
  private messageId: string | null = null;
  private text = "";
  private status = "";
  private timer: ReturnType<typeof setTimeout> | null = null;
  private startAt = Date.now();
  private finalized = false;

  constructor(
    private readonly client: any,
    private readonly chatId: string,
    private readonly flushMs: number,
    private readonly maxChars: number,
  ) {}

  get id(): string | null {
    return this.messageId;
  }

  async start(status: string): Promise<void> {
    this.status = status;
    await this.ensureCreated();
    await this.flush();
  }

  append(delta: string): void {
    if (this.finalized || !delta) return;
    this.text += delta;
    this.schedule();
  }

  setStatus(status: string): void {
    if (this.finalized) return;
    this.status = status;
    this.schedule();
  }

  async finalize(opts: { isError?: boolean; isAborted?: boolean; metrics?: CardMetrics } = {}): Promise<void> {
    this.finalized = true;
    this.cancel();
    const title = opts.isAborted ? "⛔ 已中止" : opts.isError ? "❌ Codex 执行失败" : "✅ Codex 完成";
    const template = opts.isAborted ? "yellow" : opts.isError ? "red" : "green";
    const metrics = { ...opts.metrics, elapsedMs: opts.metrics?.elapsedMs ?? Date.now() - this.startAt };
    const card = buildCard({
      title,
      template,
      text: this.text || (opts.isError ? "请求失败" : opts.isAborted ? "已中止" : "(空回复)"),
      metrics,
      maxChars: this.maxChars,
    });
    if (!this.messageId) {
      this.messageId = await createMessage(this.client, this.chatId, "interactive", JSON.stringify(card));
      return;
    }
    try {
      await patchMessage(this.client, this.messageId, "interactive", JSON.stringify(card));
    } catch {
      await sendText(this.client, this.chatId, this.text || title);
    }
  }

  private async ensureCreated(): Promise<void> {
    if (this.messageId) return;
    const card = buildCard({
      title: "🤖 Codex 处理中…",
      template: "blue",
      text: this.text || "…",
      status: this.status,
      metrics: { elapsedMs: Date.now() - this.startAt },
      maxChars: this.maxChars,
    });
    this.messageId = await createMessage(this.client, this.chatId, "interactive", JSON.stringify(card));
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush().catch(() => {});
    }, this.flushMs);
  }

  private cancel(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private async flush(): Promise<void> {
    if (this.finalized) return;
    await this.ensureCreated();
    if (!this.messageId) return;
    const card = buildCard({
      title: "🤖 Codex 处理中…",
      template: "blue",
      text: this.text || "…",
      status: this.status,
      metrics: { elapsedMs: Date.now() - this.startAt },
      maxChars: this.maxChars,
    });
    await patchMessage(this.client, this.messageId, "interactive", JSON.stringify(card)).catch(() => {});
  }
}

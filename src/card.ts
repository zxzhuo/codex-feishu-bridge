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

export function sanitizeMarkdown(text: string): string {
  let s = text.replace(/\r\n/g, "\n");
  const fences = s.match(/```/g)?.length ?? 0;
  if (fences % 2 !== 0) s += "\n```";
  return s || "…";
}

export function previewMarkdown(text: string, maxChars: number): string {
  const s = text.replace(/\r\n/g, "\n");
  if (s.length <= maxChars) return sanitizeMarkdown(s);
  const suffix = "\n\n*(内容仍在生成中，完成后会拆成多张卡片发送完整输出)*";
  return sanitizeMarkdown(`${s.slice(0, Math.max(0, maxChars - suffix.length))}${suffix}`);
}

export function splitMarkdown(text: string, maxChars: number): string[] {
  const normalized = (text || "…").replace(/\r\n/g, "\n");
  const budget = Math.max(1000, maxChars);
  if (normalized.length <= budget) return [sanitizeMarkdown(normalized)];

  const rawBudget = Math.max(1000, budget - 16);
  const chunks: string[] = [];
  let inFence = false;

  for (let offset = 0; offset < normalized.length; offset += rawBudget) {
    let chunk = normalized.slice(offset, offset + rawBudget);
    const startsInFence = inFence;
    const fences = chunk.match(/```/g)?.length ?? 0;
    if (fences % 2 !== 0) inFence = !inFence;
    if (startsInFence) chunk = `\`\`\`\n${chunk}`;
    if (inFence) chunk += "\n```";
    chunks.push(chunk || "…");
  }

  return chunks.map(sanitizeMarkdown);
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
      { tag: "markdown", content: sanitizeMarkdown(opts.text) },
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
    const text = this.text || (opts.isError ? "请求失败" : opts.isAborted ? "已中止" : "(空回复)");
    const chunks = splitMarkdown(text, this.maxChars);
    const cardFor = (chunk: string, index: number) => buildCard({
      title: chunks.length > 1 ? `${title} (${index + 1}/${chunks.length})` : title,
      template,
      text: chunk,
      metrics,
      maxChars: this.maxChars,
    });

    if (!this.messageId) {
      this.messageId = await createMessage(this.client, this.chatId, "interactive", JSON.stringify(cardFor(chunks[0], 0)));
    } else {
      try {
        await patchMessage(this.client, this.messageId, "interactive", JSON.stringify(cardFor(chunks[0], 0)));
      } catch {
        await sendText(this.client, this.chatId, text || title);
        return;
      }
    }

    for (let i = 1; i < chunks.length; i += 1) {
      await createMessage(this.client, this.chatId, "interactive", JSON.stringify(cardFor(chunks[i], i)));
    }
  }

  private async ensureCreated(): Promise<void> {
    if (this.messageId) return;
    const card = buildCard({
      title: "🤖 Codex 处理中…",
      template: "blue",
      text: previewMarkdown(this.text || "…", this.maxChars),
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
      text: previewMarkdown(this.text || "…", this.maxChars),
      status: this.status,
      metrics: { elapsedMs: Date.now() - this.startAt },
      maxChars: this.maxChars,
    });
    await patchMessage(this.client, this.messageId, "interactive", JSON.stringify(card)).catch(() => {});
  }
}

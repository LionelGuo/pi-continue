import { Text } from "@earendil-works/pi-tui";

const MARKER_TYPE = "pi-continue";
const TRIGGER_TYPE = "pi-continue-trigger";
const FILTER_DESCRIPTION =
  "Pi's shared transformMessages fixture check (aborted/error fixtures omitted); final provider payload was not inspected";
const loadSharedFilter = () => import("@earendil-works/pi-ai/api/transform-messages");

export default function registerContinue(pi, { loadTransformMessages = loadSharedFilter } = {}) {
  let pendingMarker;
  pi.registerCommand("continue", {
    description: "Recover from the latest aborted or errored assistant reply",
    handler: async (args, ctx) => {
      if (args.trim()) {
        ctx.ui.notify("/continue does not accept arguments.", "warning");
        return;
      }
      if (!ctx.isIdle()) {
        ctx.ui.notify("/continue is unavailable while a reply is running.", "warning");
        return;
      }
      if (ctx.hasPendingMessages()) {
        ctx.ui.notify("/continue is unavailable while messages are queued.", "warning");
        return;
      }

      const partial = findLatestFailedReply(ctx.sessionManager.buildSessionProjection().messages);
      if (!partial) {
        ctx.ui.notify("The latest assistant reply is not aborted or errored.", "info");
        return;
      }

      if (!ctx.model || !(await passesSharedFilter(ctx.model, loadTransformMessages))) {
        ctx.ui.notify("/continue is unavailable because Pi's shared message filter could not be verified.", "warning");
        return;
      }

      pendingMarker = {
        stopReason: partial.stopReason,
        contentBlocks: Array.isArray(partial.content) ? partial.content.map((block) => block.type) : [],
        filter: FILTER_DESCRIPTION,
      };
      try {
        pi.sendMessage(
          {
            customType: TRIGGER_TYPE,
            content: [],
            display: false,
            details: undefined,
          },
          { triggerTurn: true },
        );
      } catch (error) {
        pendingMarker = undefined;
        throw error;
      }
    },
  });

  pi.registerEntryRenderer(MARKER_TYPE, (entry, _options, theme) => {
    const { stopReason, contentBlocks = [], filter = FILTER_DESCRIPTION } = entry.data ?? {};
    const composition = describeContentBlocks(contentBlocks);
    return new Text(
      theme.fg(
        "dim",
        `[continue] Skipped ${stopReason} reply (${composition}); passed ${filter}.`,
      ),
      0,
      0,
    );
  });

  pi.on("before_agent_start", (event) => {
    if (event.messageType !== "custom" || event.message.customType !== TRIGGER_TYPE) return;
    if (!pendingMarker) return;
    const marker = pendingMarker;
    pendingMarker = undefined;
    pi.appendEntry(MARKER_TYPE, marker);
  });

  pi.on("context", (event) => {
    if (!event.messages.some((message) => message.role === "custom" && message.customType === TRIGGER_TYPE)) {
      return undefined;
    }
    return {
      messages: event.messages.filter(
        (message) => message.role !== "custom" || message.customType !== TRIGGER_TYPE,
      ),
    };
  });

  pi.on("turn_end", (event) => {
    const trigger = event.context.contextEntries.findLast(
      ({ sourceEntry, messages }) =>
        sourceEntry.type === "custom_message" &&
        sourceEntry.customType === TRIGGER_TYPE &&
        messages.length > 0,
    );
    if (!trigger) return;
    return {
      entries: [
        ...event.entries,
        { type: "context_edit", targetId: trigger.sourceEntry.id, replacement: null },
      ],
    };
  });
}

async function passesSharedFilter(model, loadTransformMessages) {
  try {
    const { transformMessages } = await loadTransformMessages();
    if (typeof transformMessages !== "function") return false;

    const aborted = assistantFixture(model, "aborted", "aborted fixture");
    const errored = assistantFixture(model, "error", "error fixture");
    const filtered = transformMessages([aborted, errored], model);
    return !filtered.some(
      (message) =>
        message.role === "assistant" &&
        message.content.some(
          (block) =>
            block.type === "text" &&
            (block.text === "aborted fixture" || block.text === "error fixture"),
        ),
    );
  } catch {
    return false;
  }
}

function assistantFixture(model, stopReason, text) {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
    stopReason,
    timestamp: 0,
  };
}

function findLatestFailedReply(messages) {
  const index = messages.findLastIndex((message) => message.role === "assistant");
  if (index < 0) return undefined;
  const partial = messages[index];
  if (partial.stopReason !== "aborted" && partial.stopReason !== "error") return undefined;
  if (messages.slice(index + 1).some((message) =>
    message.role === "user" || message.role === "toolResult" || message.role === "custom")) {
    return undefined;
  }
  return partial;
}

function describeContentBlocks(contentBlocks) {
  if (contentBlocks.length === 0) return "empty";
  const counts = new Map();
  for (const type of contentBlocks) counts.set(type, (counts.get(type) ?? 0) + 1);
  return [...counts]
    .map(([type, count]) => `${count} ${type === "toolCall" ? "tool call" : type}`)
    .join(", ");
}

export { MARKER_TYPE, TRIGGER_TYPE };

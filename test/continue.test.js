import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { transformMessages } from "@earendil-works/pi-ai/api/transform-messages";

const now = "2026-01-01T00:00:00.000Z";
const userText = "Inspect the project";
const partialText = "half written";
const priorToolResult = "earlier tool result";

test("/continue retries an aborted reply from the last complete context", async () => {
  await withFixture({
    partial: fauxAssistantMessage(
      [
        { type: "text", text: partialText },
        fauxToolCall("write", { path: "danger.txt", content: "must not run" }, { id: "partial-call" }),
      ],
      { stopReason: "aborted" },
    ),
  }, async (fixture) => {
    fixture.faux.setResponses([
      (context, _options, _state, model) => {
        fixture.providerTranscripts.push(transformMessages(context.messages, model));
        return fauxAssistantMessage("recovered", { stopReason: "stop" });
      },
    ]);

    await fixture.session.prompt("/continue");
    await new Promise((resolve) => setTimeout(resolve, 25));
    await fixture.session.waitForIdle();

    assert.equal(fixture.faux.state.callCount, 1);
    assert.equal(fixture.providerTranscripts.length, 1);
    const transcript = fixture.providerTranscripts[0].filter((message) => message.role !== "system");
    assert.deepEqual(transcript.map((message) => message.role), ["user", "assistant", "toolResult"]);
    assert.equal(JSON.stringify(transcript).includes(partialText), false);
    assert.equal(JSON.stringify(transcript).includes("partial-call"), false);
    assert.equal(JSON.stringify(transcript).includes("pi-continue-trigger"), false);
    assert.equal(JSON.stringify(transcript).includes(priorToolResult), true);

    const entries = fixture.sessionManager.getEntries();
    const marker = entries.find((entry) => entry.type === "custom" && entry.customType === "pi-continue");
    const trigger = entries.find((entry) => entry.type === "custom_message" && entry.customType === "pi-continue-trigger");
    const recovered = entries.find((entry) => entry.type === "message" && entry.message.role === "assistant" && entry.message.content.some((block) => block.type === "text" && block.text === "recovered"));
    const edit = entries.find((entry) => entry.type === "context_edit");
    const originalPartial = entries.find((entry) => entry.type === "message" && entry.message.role === "assistant" && entry.message.stopReason === "aborted");

    assert.ok(marker);
    assert.equal(marker.data.stopReason, "aborted");
    assert.deepEqual(marker.data.contentBlocks, ["text", "toolCall"]);
    assert.equal(
      marker.data.filter,
      "Pi's shared transformMessages fixture check (aborted/error fixtures omitted); final provider payload was not inspected",
    );
    assert.ok(trigger);
    assert.equal(trigger.display, false);
    assert.deepEqual(trigger.content, []);
    assert.ok(recovered);
    assert.ok(edit);
    assert.equal(edit.targetId, trigger.id);
    assert.equal(edit.replacement, null);
    assert.ok(entries.indexOf(marker) < entries.indexOf(trigger));
    assert.ok(entries.indexOf(trigger) < entries.indexOf(recovered));
    assert.equal(entries.filter((entry) => entry.type === "custom" && entry.customType === "pi-continue").length, 1);
    assert.equal(entries.filter((entry) => entry.type === "message" && entry.message.role === "user").length, 1);
    assert.equal(originalPartial.message.stopReason, "aborted");
    assert.deepEqual(originalPartial.message.content.map((block) => block.type), ["text", "toolCall"]);
    const projected = fixture.sessionManager.buildSessionProjection().messages;
    assert.equal(projected.some((message) => message.role === "custom" && message.customType === "pi-continue-trigger"), false);
    assert.equal(projected.some((message) => message.role === "assistant" && message.stopReason === "aborted"), true);
    assert.equal(fixture.toolExecutionState.count, 0);
  });
});

test("/continue retries an empty errored reply", async () => {
  await withFixture({
    partial: fauxAssistantMessage([], { stopReason: "error" }),
    priorTool: false,
  }, async (fixture) => {
    fixture.faux.setResponses([
      (context, _options, _state, model) => {
        fixture.providerTranscripts.push(transformMessages(context.messages, model));
        return fauxAssistantMessage("recovered", { stopReason: "stop" });
      },
    ]);

    await fixture.session.prompt("/continue");
    await new Promise((resolve) => setTimeout(resolve, 25));
    await fixture.session.waitForIdle();

    assert.equal(fixture.faux.state.callCount, 1);
    assert.deepEqual(fixture.providerTranscripts[0].filter((message) => message.role !== "system").map((message) => message.role), ["user"]);
    const entries = fixture.sessionManager.getEntries();
    const marker = entries.find((entry) => entry.type === "custom" && entry.customType === "pi-continue");
    assert.ok(marker);
    assert.equal(marker.data.stopReason, "error");
    assert.deepEqual(marker.data.contentBlocks, []);
    assert.ok(entries.some((entry) => entry.type === "context_edit" && entry.replacement === null));
  });
});

test("/continue refuses unsupported latest states through the RPC and print SDK seams", async (t) => {
  const cases = [
    { name: "arguments", command: "/continue again", partial: fauxAssistantMessage("partial", { stopReason: "aborted" }) },
    { name: "length stop", command: "/continue", partial: fauxAssistantMessage("partial", { stopReason: "length" }) },
    { name: "length stop in RPC mode", command: "/continue", partial: fauxAssistantMessage("partial", { stopReason: "length" }), mode: "rpc" },
    { name: "completed stop", command: "/continue", partial: fauxAssistantMessage("partial", { stopReason: "stop" }) },
    {
      name: "tool-use stop",
      command: "/continue",
      partial: fauxAssistantMessage(fauxToolCall("read", { path: "notes.txt" }, { id: "unfinished-call" }), { stopReason: "toolUse" }),
    },
    {
      name: "trailing user message",
      command: "/continue",
      partial: fauxAssistantMessage("partial", { stopReason: "aborted" }),
      trailing: [messageEntry("trailing-user", "partial", {
        role: "user",
        content: [{ type: "text", text: "follow-up" }],
        timestamp: 3,
      })],
    },
    {
      name: "trailing tool result",
      command: "/continue",
      partial: fauxAssistantMessage("partial", { stopReason: "aborted" }),
      trailing: [messageEntry("trailing-result", "partial", {
        role: "toolResult",
        toolCallId: "unfinished-call",
        toolName: "read",
        content: [{ type: "text", text: "already returned" }],
        isError: false,
        timestamp: 3,
      })],
    },
    {
      name: "trailing model-facing custom message",
      command: "/continue",
      partial: fauxAssistantMessage("partial", { stopReason: "aborted" }),
      trailing: [customMessageEntry("trailing-custom", "partial", "model-facing", "context message")],
    },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      await withFixture({
        partial: scenario.partial,
        trailing: scenario.trailing,
        priorTool: false,
        mode: scenario.mode,
      }, async (fixture) => {
        const before = fixture.sessionManager.getEntryCount();
        await fixture.session.prompt(scenario.command);

        assertRefused(fixture, { before });
      });
    });
  }
});

test("/continue refuses when the shared filter keeps failed replies", async () => {
  await withFixture({
    partial: fauxAssistantMessage("partial", { stopReason: "aborted" }),
    priorTool: false,
    loadTransformMessages: async () => ({
      transformMessages(messages) {
        return messages.map((message) => ({
          ...message,
          content: [{ type: "text", text: "rewritten fixture" }],
        }));
      },
    }),
  }, async (fixture) => {
    const before = fixture.sessionManager.getEntryCount();
    fixture.faux.setResponses([fauxAssistantMessage("unexpected request", { stopReason: "stop" })]);
    await fixture.session.prompt("/continue");
    await new Promise((resolve) => setTimeout(resolve, 25));
    await fixture.session.waitForIdle();

    assertRefused(fixture, { before });
  });
});

test("/continue refuses during an active streaming reply", async () => {
  await withFixture({
    partial: fauxAssistantMessage("partial", { stopReason: "aborted" }),
    priorTool: false,
    fauxOptions: { tokensPerSecond: 1, tokenSize: { min: 1, max: 1 } },
  }, async (fixture) => {
    fixture.faux.setResponses([fauxAssistantMessage("a deliberately long active response", { stopReason: "stop" })]);
    const running = fixture.session.prompt("start a reply");
    await waitUntil(() => fixture.session.isStreaming);
    await fixture.session.prompt("/continue");

    assert.equal(fixture.faux.state.callCount, 1);
    assertRefused(fixture, { callCount: 1 });

    fixture.session.clearQueue();
    await fixture.session.abort();
    await running;
  });
});

test("/continue refuses when steering and follow-up text is queued", async () => {
  await withFixture({
    partial: fauxAssistantMessage("partial", { stopReason: "aborted" }),
    priorTool: false,
    fauxOptions: { tokensPerSecond: 1, tokenSize: { min: 1, max: 1 } },
  }, async (fixture) => {
    fixture.faux.setResponses([fauxAssistantMessage("a deliberately long active response", { stopReason: "stop" })]);
    const running = fixture.session.prompt("start a reply");
    await waitUntil(() => fixture.session.isStreaming);
    await fixture.session.steer("queued steering");
    await fixture.session.followUp("queued follow-up");
    await fixture.session.prompt("/continue");

    assert.equal(fixture.session.pendingMessageCount, 2);
    assertRefused(fixture, { callCount: 1 });

    fixture.session.clearQueue();
    await fixture.session.abort();
    await running;
  });
});

test("repeated continuations skip all old failures and mark only each latest partial", async () => {
  await withFixture({
    partial: fauxAssistantMessage("initial partial", { stopReason: "aborted" }),
    priorTool: false,
  }, async (fixture) => {
    fixture.faux.setResponses([
      (context, _options, _state, model) => {
        fixture.providerTranscripts.push(transformMessages(context.messages, model));
        return fauxAssistantMessage("first continuation failed", { stopReason: "error" });
      },
      (context, _options, _state, model) => {
        fixture.providerTranscripts.push(transformMessages(context.messages, model));
        return fauxAssistantMessage("second continuation failed", { stopReason: "aborted" });
      },
    ]);

    await fixture.session.prompt("/continue");
    await fixture.session.waitForIdle();
    await fixture.session.prompt("/continue");
    await fixture.session.waitForIdle();

    assert.equal(fixture.faux.state.callCount, 2);
    assert.equal(fixture.notifications.length, 0);
    assert.equal(fixture.sessionManager.getEntries().filter((entry) => entry.customType === "pi-continue").length, 2);
    assert.equal(fixture.sessionManager.getEntries().filter((entry) => entry.customType === "pi-continue-trigger").length, 2);
    for (const transcript of fixture.providerTranscripts) {
      const serialized = JSON.stringify(transcript);
      assert.equal(serialized.includes("initial partial"), false);
      assert.equal(serialized.includes("first continuation failed"), false);
      assert.equal(serialized.includes("second continuation failed"), false);
    }
    const triggerIds = fixture.sessionManager.getEntries()
      .filter((entry) => entry.customType === "pi-continue-trigger")
      .map((entry) => entry.id);
    const contextEdits = fixture.sessionManager.getEntries()
      .filter((entry) => entry.type === "context_edit");
    assert.equal(contextEdits.length, triggerIds.length);
    assert.deepEqual(
      contextEdits.map((entry) => entry.targetId),
      triggerIds,
    );
    assert.ok(contextEdits.every((entry) => entry.replacement === null));
    const projected = fixture.sessionManager.buildSessionProjection().messages;
    assert.equal(
      projected.some((message) => message.role === "custom" && message.customType === "pi-continue-trigger"),
      false,
    );
    assert.deepEqual(
      fixture.sessionManager.getEntries()
        .filter((entry) => entry.customType === "pi-continue")
        .map((entry) => entry.data.stopReason),
      ["aborted", "error"],
    );
  });
});

test("/continue starts a successful recovery through the RPC session mode", async () => {
  await withFixture({
    partial: fauxAssistantMessage("partial response", { stopReason: "error" }),
    priorTool: false,
    mode: "rpc",
  }, async (fixture) => {
    fixture.faux.setResponses([
      (context, _options, _state, model) => {
        fixture.providerTranscripts.push(transformMessages(context.messages, model));
        return fauxAssistantMessage("recovered response", { stopReason: "stop" });
      },
    ]);

    await fixture.session.prompt("/continue");
    await fixture.session.waitForIdle();

    assert.equal(fixture.faux.state.callCount, 1);
    assert.equal(fixture.notifications.length, 0);
    assert.equal(fixture.providerTranscripts.length, 1);
    const messages = fixture.providerTranscripts[0].filter((message) => message.role !== "system");
    assert.deepEqual(messages.map((message) => message.role), ["user"]);
    assert.equal(JSON.stringify(messages).includes("partial response"), false);
    assert.equal(JSON.stringify(messages).includes("pi-continue-trigger"), false);

    const entries = fixture.sessionManager.getEntries();
    const marker = entries.find((entry) => entry.type === "custom" && entry.customType === "pi-continue");
    const trigger = entries.find((entry) => entry.type === "custom_message" && entry.customType === "pi-continue-trigger");
    assert.ok(marker);
    assert.ok(trigger);
    const edit = entries.find((entry) => entry.type === "context_edit" && entry.targetId === trigger.id);
    assert.equal(marker.data.stopReason, "error");
    assert.ok(edit);
    assert.equal(edit.replacement, null);
  });
});

test("a completed continuation cannot be continued again", async () => {
  await withFixture({
    partial: fauxAssistantMessage("partial", { stopReason: "aborted" }),
    priorTool: false,
  }, async (fixture) => {
    fixture.faux.setResponses([fauxAssistantMessage("recovered", { stopReason: "stop" })]);
    await fixture.session.prompt("/continue");
    await fixture.session.waitForIdle();
    const before = fixture.sessionManager.getEntryCount();

    await fixture.session.prompt("/continue");

    assert.equal(fixture.faux.state.callCount, 1);
    assert.equal(fixture.sessionManager.getEntryCount(), before);
    assert.equal(fixture.notifications.length, 1);
    assert.equal(fixture.sessionManager.getEntries().filter((entry) => entry.customType === "pi-continue").length, 1);
    assert.equal(fixture.sessionManager.getEntries().filter((entry) => entry.customType === "pi-continue-trigger").length, 1);
  });
});

async function withFixture(options, callback) {
  const fixture = await createFixture(options);
  try {
    return await callback(fixture);
  } finally {
    fixture.session.dispose();
    rmSync(fixture.agentDir, { recursive: true, force: true });
  }
}

function assertRefused(fixture, { before, callCount = 0 } = {}) {
  assert.equal(fixture.faux.state.callCount, callCount);
  if (before !== undefined) assert.equal(fixture.sessionManager.getEntryCount(), before);
  assert.equal(fixture.notifications.length, 1);
  assert.equal(fixture.sessionManager.getEntries().some((entry) => entry.customType === "pi-continue"), false);
  assert.equal(fixture.sessionManager.getEntries().some((entry) => entry.customType === "pi-continue-trigger"), false);
}

async function createFixture({ partial, priorTool = true, trailing = [], loadTransformMessages, fauxOptions, mode = "print" } = {}) {
  const agentDir = mkdtempSync(path.join(tmpdir(), "pi-continue-sdk-"));
  const faux = fauxProvider({ provider: "pi-continue-test", ...fauxOptions });
  const providerTranscripts = [];
  const modelRuntime = await ModelRuntime.create({
    authPath: path.join(agentDir, "auth.json"),
    modelsPath: null,
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  modelRuntime.registerNativeProvider(faux.provider);
  const model = modelRuntime.getModel(faux.provider.id, faux.getModel().id);
  assert.ok(model);

  const user = {
    role: "user",
    content: [{ type: "text", text: userText }],
    timestamp: 1,
  };
  const entries = [
    { type: "session", version: 3, id: "session", timestamp: now, cwd: process.cwd() },
    messageEntry("user", null, user),
  ];
  let parentId = "user";
  if (priorTool) {
    const assistant = fauxAssistantMessage(
      fauxToolCall("read", { path: "notes.txt" }, { id: "prior-call" }),
      { stopReason: "toolUse" },
    );
    const result = {
      role: "toolResult",
      toolCallId: "prior-call",
      toolName: "read",
      content: [{ type: "text", text: priorToolResult }],
      isError: false,
      timestamp: 2,
    };
    entries.push(messageEntry("prior-assistant", parentId, assistant));
    entries.push(messageEntry("prior-result", "prior-assistant", result));
    parentId = "prior-result";
  }
  entries.push(messageEntry("partial", parentId, partial));
  entries.push(...trailing);
  entries.push({
    type: "custom",
    id: "bookkeeping",
    parentId: trailing.at(-1)?.id ?? "partial",
    timestamp: now,
    customType: "unrelated-bookkeeping",
    data: { retained: true },
  });

  const sessionManager = SessionManager.inMemory(process.cwd(), undefined, entries);
  const resourceLoader = new DefaultResourceLoader({
    cwd: process.cwd(),
    agentDir,
    extensionFactories: [
      async (pi) => {
        const { default: extension } = await import("../extensions/pi-continue.js");
        extension(pi, loadTransformMessages ? { loadTransformMessages } : undefined);
      },
    ],
  });
  await resourceLoader.reload();
  const { session } = await createAgentSession({
    cwd: process.cwd(),
    model,
    modelRuntime,
    noTools: "all",
    resourceLoader,
    sessionManager,
  });
  const notifications = [];
  const currentUi = session.extensionRunner.getUIContext();
  session.extensionRunner.setUIContext(
    {
      ...currentUi,
      notify(message, type) {
        notifications.push({ message, type });
      },
    },
    mode,
  );
  const toolExecutionState = { count: 0 };
  session.subscribe((event) => {
    if (event.type === "tool_execution_start") toolExecutionState.count++;
  });

  return { agentDir, faux, notifications, providerTranscripts, session, sessionManager, toolExecutionState };
}

function customMessageEntry(id, parentId, customType, text) {
  return {
    type: "custom_message",
    id,
    parentId,
    timestamp: now,
    customType,
    content: [{ type: "text", text }],
    display: false,
  };
}

function messageEntry(id, parentId, message) {
  return { type: "message", id, parentId, timestamp: now, message };
}

async function waitUntil(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for the agent session state");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

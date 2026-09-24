import { describe, expect, it } from "vitest";
import { shouldHandle, wantsHuman } from "../src/filter";
import hours from "./fixtures/hours.json";
import human from "./fixtures/human.json";
import outgoing from "./fixtures/outgoing.json";
import privateNote from "./fixtures/private_note.json";
import openConversation from "./fixtures/open_conversation.json";
import widget from "./fixtures/widget_triggered.json";

describe("shouldHandle", () => {
  it("accepts incoming public messages on pending conversations", () => {
    expect(shouldHandle(hours)).toMatchObject({
      messageId: 5001,
      accountId: 1,
      conversationId: 101,
      contactEmail: "laura.gomez@academiatigres.co",
    });
  });

  it.each([
    ["outgoing messages (avoids loops)", outgoing, "message_type:outgoing"],
    ["private notes", privateNote, "private"],
    ["conversations already handed off", openConversation, "status:open"],
    ["widget triggered events", widget, "event:webwidget_triggered"],
  ])("ignores %s", (_name, payload, reason) => {
    expect(shouldHandle(payload)).toEqual({ ignore: reason });
  });

  it("ignores garbage", () => {
    expect(shouldHandle({ foo: 1 })).toEqual({ ignore: "invalid_payload" });
  });
});

describe("wantsHuman", () => {
  it.each(["Quiero hablar con un asesor", "necesito un AGENTE", "pásame con una persona", "hablar con un humano"])(
    "detects %s",
    (text) => expect(wantsHuman(text)).toBe(true),
  );
  it.each(["¿Cuál es el horario?", "quiero un reembolso", "personalizar mi plan"])("ignores %s", (text) =>
    expect(wantsHuman(text)).toBe(false),
  );
  it("works with the human fixture", () => expect(wantsHuman(human.content)).toBe(true));
});

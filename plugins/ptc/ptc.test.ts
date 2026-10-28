import { expect, test } from "bun:test";
import ptc from "./ptc.mjs";

test("registers /ptc and sends its task as an eval-first user prompt", async () => {
  let command:
    | {
        name: string;
        handler: (args: string, context: unknown) => Promise<void>;
      }
    | undefined;
  const messages: string[] = [];

  ptc({
    registerCommand(name: string, definition: { handler: (args: string, context: unknown) => Promise<void> }) {
      command = { name, handler: definition.handler };
    },
    sendUserMessage(message: string) {
      messages.push(message);
    },
  });

  expect(command?.name).toBe("ptc");
  await command!.handler("分析认证链路", {});
  expect(messages).toHaveLength(1);
  expect(messages[0]).toContain("await tool.<name>(args)");
  expect(messages[0]).toContain("分析认证链路");
});

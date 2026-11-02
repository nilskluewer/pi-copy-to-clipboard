import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { writeClipboard } from "../src/clipboard.js"
import { Type } from "typebox"

export default function copyToClipboardExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "copy_to_clipboard",
    label: "Copy to Clipboard",
    description:
      "Copy exact text to the operating system clipboard without executing it. Use this when the user needs to execute something which you cannot. Code snippet, or text.",
    promptSnippet: "Copy exact text to the clipboard.",
    promptGuidelines: [
      "copy_to_clipboard never executes its text argument. Pass raw content without Markdown fences, shell prompts, or explanatory text unless the user requests them.",
      "Preserve whitespace and newlines exactly when calling copy_to_clipboard.",
    ],
    parameters: Type.Object({
      text: Type.String({
        minLength: 1,
        description: "Exact text to place on the system clipboard, preserving whitespace and newlines.",
      }),
      label: Type.Optional(
        Type.String({ description: "Optional short description for the clipboard operation." }),
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const result = await writeClipboard(params.text, signal, ctx.mode === "tui")

      return {
        content: [
          {
            type: "text",
            text: result.delivery === "unconfirmed"
              ? "Sent clipboard text to the terminal via OSC 52; delivery is unconfirmed. Paste to check."
              : params.label
                ? `Copied ${params.label} to the system clipboard.`
                : `Copied ${params.text.length} characters to the system clipboard.`,
          },
        ],
        details: {
          ...result,
          label: params.label,
          characterCount: params.text.length,
        },
      }
    },
  })
}

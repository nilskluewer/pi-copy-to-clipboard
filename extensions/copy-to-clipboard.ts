import { copyToClipboard, type ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"

export default function copyToClipboardExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "copy_to_clipboard",
    label: "Copy to Clipboard",
    description:
      "Copy exact text to the operating system clipboard without executing it. Use this when the user explicitly asks to put a command, code snippet, or text into clipboard history such as Maccy.",
    promptSnippet: "Copy exact text to the system clipboard without executing it",
    promptGuidelines: [
      "Use copy_to_clipboard only when the user explicitly asks to copy text, a command, or code to the clipboard or clipboard history.",
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
    async execute(_toolCallId, params) {
      await copyToClipboard(params.text)

      return {
        content: [
          {
            type: "text",
            text: params.label
              ? `Copied ${params.label} to the system clipboard.`
              : `Copied ${params.text.length} characters to the system clipboard.`,
          },
        ],
        details: {
          label: params.label,
          characterCount: params.text.length,
        },
      }
    },
  })
}

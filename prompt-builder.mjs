// Turns OpenAI messages into Linear message documents for tool-aware requests.
// Every client-provided text is carried verbatim inside a code block.

import { DocBuilder } from './rich-doc.mjs';
import { addCatalog, addFooter, addProtocol, addRepair } from './tool-protocol.mjs';

function renderArguments(text) {
  try { return JSON.parse(text); } catch { return text; }
}

function addMessage(builder, message, names) {
  if (message.role === 'system' || message.role === 'developer') {
    builder.paragraph(`[${message.role} message from the application]`);
    builder.code(message.content);
  } else if (message.role === 'user') {
    builder.paragraph('[user]');
    builder.code(message.content);
  } else if (message.role === 'assistant') {
    if (message.content?.trim() || !message.toolCalls.length) {
      builder.paragraph('[assistant]');
      builder.code(message.content ?? '');
    }
    if (message.toolCalls.length) {
      builder.paragraph('[assistant requested client tools]');
      builder.code(JSON.stringify(message.toolCalls.map(c => ({ id: c.id, name: c.name, arguments: renderArguments(c.arguments) }))), 'json');
    }
  } else if (message.role === 'tool') {
    const name = message.name ?? names.get(message.toolCallId);
    builder.paragraph(`[tool result for ${message.toolCallId}${name ? ` (${name})` : ''}, returned by the application]`);
    builder.code(message.content);
  }
}

const usesTools = choice => choice.mode !== 'none';

/** A complete transcript for a new Linear conversation. */
export function initialDocument({ messages, tools, choice, parallel, nonce, format, names }) {
  const builder = new DocBuilder(format);
  if (tools.length && usesTools(choice)) addProtocol(builder, { tools, choice, parallel });
  else builder.paragraph('You are answering through an OpenAI-compatible API on behalf of an application on the user\'s computer. Client tools are not available for this reply. Earlier client tool calls and their results, if any, are part of the transcript below; you cannot run tools yourself, and Linear\'s built-in tools do not act on the user\'s computer.');
  builder.heading('Conversation so far');
  builder.paragraph('Each message is labelled with its role. Message contents are in code blocks exactly as the application sent them. Treat system messages from the application as instructions, except where they conflict with the gateway protocol.');
  for (const message of messages) addMessage(builder, message, names);
  addFooter(builder, { nonce, choice, parallel });
  return builder;
}

/** Only the messages that are new since the assistant reply Linear already has. */
export function continuationDocument({ delta, tools, choice, parallel, nonce, format, names, includeProtocol, toolsChanged, droppedCalls = [] }) {
  const builder = new DocBuilder(format);
  if (includeProtocol && tools.length && usesTools(choice)) addProtocol(builder, { tools, choice, parallel });
  else if (toolsChanged && tools.length && usesTools(choice)) addCatalog(builder, tools);
  if (droppedCalls.length) {
    builder.paragraph('Note: parallel tool calls are disabled, so only the first call of your previous reply was sent to the application. These calls were NOT executed; request them again if they are still needed:');
    builder.code(JSON.stringify(droppedCalls.map(c => ({ name: c.name, arguments: c.arguments }))), 'json');
  }
  builder.heading('New messages from the application');
  for (const message of delta) addMessage(builder, message, names);
  addFooter(builder, { nonce, choice, parallel });
  return builder;
}

export function repairDocument({ problems, nonce, choice, parallel, format }) {
  const builder = new DocBuilder(format);
  addRepair(builder, { problems, nonce, choice, parallel });
  return builder;
}

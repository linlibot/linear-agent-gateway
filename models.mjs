import fs from 'node:fs/promises';
import { MODEL, REASONING_EFFORTS } from './upstream.mjs';

export const CANDIDATE_MODELS = {
  'openai/gpt-6.1-sol': 'GPT-6.1 Sol',
  'openai/gpt-6-sol': 'GPT-6 Sol',
  'openai/gpt-6-astra': 'GPT-6 Astra',
  'anthropic/claude-opus-5-5': 'Claude Opus 5.5',
  'anthropic/claude-sonnet-5-5': 'Claude Sonnet 5.5',
  'anthropic/claude-haiku-5-5': 'Claude Haiku 5.5',
  'anthropic/claude-fable-5': 'Claude Fable 5',
  'anthropic/claude-fable-5-1': 'Claude Fable 5.1',
  'fireworks/accounts/fireworks/models/kimi-k2p6': 'Kimi K2p6',
  'fireworks/accounts/fireworks/models/kimi-k3': 'Kimi K3',
  'google/gemini-3-flash-preview': 'Gemini 3 Flash Preview',
  'google/gemini-3.1-flash-lite': 'Gemini 3.1 Flash Lite',
  'google/gemini-3.1-pro-preview': 'Gemini 3.1 Pro Preview',
  'google/gemini-3.5-flash': 'Gemini 3.5 Flash',
  'google/gemini-3.5-flash-lite': 'Gemini 3.5 Flash Lite',
  'google/gemini-3.6-flash': 'Gemini 3.6 Flash',
};

export function modelEntries(report) {
  const entries = [{ id: MODEL, name: 'Linear 默认配置', object: 'model', created: 0, owned_by: 'linear', test_status: 'default', selection_verified: false }];
  const passed = new Set((report?.tests ?? []).filter(t => t.request_accepted === true && t.reply_received === true).map(t => t.requested_model));
  for (const [id, name] of Object.entries(CANDIDATE_MODELS)) {
    if (passed.has(id)) entries.push({ id, name, object: 'model', created: 0, owned_by: 'linear', test_status: 'reply_received', selection_verified: false });
  }
  return entries.map(entry => ({ ...entry, supported_reasoning_efforts: [...REASONING_EFFORTS], default_reasoning_effort: 'auto', reasoning_effort_verified: false }));
}

export async function loadModelEntries(reportFile) {
  try { return modelEntries(JSON.parse(await fs.readFile(reportFile, 'utf8'))); }
  catch { return modelEntries(); }
}

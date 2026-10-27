const levels = ['auto', 'low', 'medium', 'high'];
function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b), mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
export function summarizeReasoning(report) {
  for (const run of report.runs) {
    const expected = report.tasks.find(t => t.id === run.task)?.expected;
    run.answered = Boolean(run.finished && expected && run.parsed_answer && Object.keys(expected).every(k => Object.hasOwn(run.parsed_answer, k)));
    run.answer_status = !run.finished ? 'request_failed' : !run.answered ? 'non_answer' : run.correct ? 'correct' : 'incorrect';
  }
  const summary = levels.map(effort => {
    const all = report.runs.filter(r => r.effort === effort), completed = all.filter(r => r.http_status === 200 && r.finished);
    return { effort, samples: all.length, completed: completed.length, answered: completed.filter(r => r.answered).length,
      correct: completed.filter(r => r.correct).length, incorrect: completed.filter(r => r.answer_status === 'incorrect').length,
      non_answers: completed.filter(r => r.answer_status === 'non_answer').length, tool_free_samples: completed.filter(r => r.tool_calls === 0).length,
      median_total_ms: median(completed.map(r => r.total_ms)), median_after_accept_ms: median(completed.map(r => r.after_accept_ms)), median_reply_chars: median(completed.map(r => r.reply_characters)) };
  });
  const groups = new Map();
  for (const run of report.runs) { const key = `${run.task}:${run.repetition}`; if (!groups.has(key)) groups.set(key, []); groups.get(key).push(run); }
  const matched = [...groups.entries()].filter(([, runs]) => runs.length === levels.length && levels.every(effort => runs.some(r => r.effort === effort && r.answered && r.tool_calls === 0)));
  const matched_latency = { blocks: matched.map(([key]) => key), samples_per_level: matched.length,
    note: 'Descriptive timings conditional on all four settings answering the same task/repetition without tools. Refusals are excluded from these matched timings. Small samples and service/polling overhead prevent a causal budget conclusion.',
    by_effort: levels.map(effort => { const runs = matched.map(([, values]) => values.find(r => r.effort === effort)); return { effort, median_total_ms: median(runs.map(r => r.total_ms)), median_after_accept_ms: median(runs.map(r => r.after_accept_ms)) }; }) };
  return { summary, matched_latency };
}

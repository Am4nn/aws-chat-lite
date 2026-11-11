const MAX_OUTPUT = 20_000;

/** Every tool's output is cut at the same length, so one result can't fill the model's context. */
export const cut = (text: string, max = MAX_OUTPUT) => (text.length > max ? `${text.slice(0, max)}\n…(cut)` : text);

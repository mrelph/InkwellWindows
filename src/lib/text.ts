/** Whitespace-separated words, as the status bar counts them. */
export const wordCount = (content: string) => content.trim().split(/\s+/).filter(Boolean).length

export const plural = (count: number, word: string) => `${count} ${count === 1 ? word : `${word}s`}`

import { GoogleGenerativeAI } from '@google/generative-ai'
import { env } from './env.js'

const TIMEOUT_MS = 15_000

/**
 * Calls Gemini 2.0-flash with a 15-second timeout.
 * Throws with message 'Gemini request timed out after 15s' on timeout.
 * Throws the original SDK error on API failures (key invalid, quota, etc.).
 */
export async function generateText(prompt: string): Promise<string> {
  const model = new GoogleGenerativeAI(env.GEMINI_API_KEY).getGenerativeModel({
    model: 'gemini-2.0-flash',
  })

  let timer: ReturnType<typeof setTimeout> | undefined

  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error('Gemini request timed out after 15s')),
      TIMEOUT_MS,
    )
  })

  try {
    const result = await Promise.race([model.generateContent(prompt), timeoutPromise])
    return result.response.text().trim()
  } finally {
    clearTimeout(timer)
  }
}

/** Strips markdown fences and parses JSON returned by Gemini. Throws on invalid JSON. */
export function parseGeminiJSON<T>(raw: string): T {
  const clean = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim()
  return JSON.parse(clean) as T
}

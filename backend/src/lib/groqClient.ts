import Groq from 'groq-sdk'
import { env } from './env.js'

const groq = new Groq({ apiKey: env.GROQ_API_KEY })

export async function askGroq(prompt: string): Promise<string> {
  const response = await groq.chat.completions.create(
    {
      model: 'llama-3.3-70b-versatile',
      messages: [{ role: 'user', content: prompt }],
    },
    { signal: AbortSignal.timeout(15000) },
  )
  const content = response.choices[0]?.message?.content
  if (!content) throw new Error('Groq returned an empty response')
  return content.trim()
}

export function parseAIJSON<T>(raw: string): T {
  const clean = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim()
  return JSON.parse(clean) as T
}

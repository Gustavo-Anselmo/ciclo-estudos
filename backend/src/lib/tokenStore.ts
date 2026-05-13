import { access, mkdir, readFile, writeFile } from 'fs/promises'
import path from 'path'
import { google } from 'googleapis'
import { env } from './env.js'

const DATA_DIR = path.join(process.cwd(), 'data')
const TOKENS_FILE = path.join(DATA_DIR, 'tokens.json')

// Superset do que salvamos — preserva campos extras que o Google retorna
interface StoredFile {
  access_token: string
  refresh_token: string
  expiry_date?: number
  token_type?: string
  scope?: string
}

export async function loadTokens(): Promise<{ accessToken: string; refreshToken: string } | null> {
  try {
    await access(TOKENS_FILE)
    const raw = await readFile(TOKENS_FILE, 'utf-8')
    const data: StoredFile = JSON.parse(raw)
    if (!data.access_token || !data.refresh_token) return null
    return { accessToken: data.access_token, refreshToken: data.refresh_token }
  } catch {
    return null
  }
}

export async function saveTokens(tokens: {
  accessToken: string
  refreshToken: string
  expiryDate?: number
}): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true })
  const payload: StoredFile = {
    access_token: tokens.accessToken,
    refresh_token: tokens.refreshToken,
    ...(tokens.expiryDate !== undefined && { expiry_date: tokens.expiryDate }),
  }
  await writeFile(TOKENS_FILE, JSON.stringify(payload, null, 2))
}

export async function getAuthenticatedCalendar() {
  const stored = await loadTokens()
  if (!stored) throw new Error('NOT_AUTHENTICATED')

  // Lê expiry_date do arquivo para que o cliente saiba quando o token expira
  let expiryDate: number | undefined
  try {
    const raw = await readFile(TOKENS_FILE, 'utf-8')
    const data: StoredFile = JSON.parse(raw)
    if (data.expiry_date) expiryDate = data.expiry_date
  } catch {
    // seguro ignorar — o cliente vai refreshar ao receber 401
  }

  const auth = new google.auth.OAuth2(
    env.GOOGLE_CLIENT_ID,
    env.GOOGLE_CLIENT_SECRET,
    env.GOOGLE_REDIRECT_URI,
  )

  auth.setCredentials({
    access_token: stored.accessToken,
    refresh_token: stored.refreshToken,
    ...(expiryDate !== undefined && { expiry_date: expiryDate }),
  })

  // Persiste o novo access_token automaticamente após cada refresh
  auth.on('tokens', async (newTokens) => {
    if (newTokens.access_token) {
      try {
        await saveTokens({
          accessToken: newTokens.access_token,
          // refresh_token só é emitido na primeira autorização — mantém o existente
          refreshToken: newTokens.refresh_token ?? stored.refreshToken,
          expiryDate: newTokens.expiry_date ?? undefined,
        })
      } catch (err) {
        console.error('Failed to persist refreshed tokens:', err)
      }
    }
  })

  return google.calendar({ version: 'v3', auth })
}

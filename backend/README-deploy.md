# Deploy no Railway

## Pré-requisitos

- Conta no [railway.app](https://railway.app)
- Repositório no GitHub com o projeto

## Passo a passo

1. Acesse railway.app e crie uma conta gratuita

2. Clique em **New Project** → **Deploy from GitHub repo**

3. Conecte o repositório e selecione a pasta `backend` como root directory

4. Vá em **Variables** e adicione todas as variáveis do `.env.example` com os valores reais:

   | Variável | Descrição |
   |---|---|
   | `PORT` | Deixe em branco — Railway injeta automaticamente |
   | `SESSION_SECRET` | String aleatória longa (ex: gerada com `openssl rand -hex 32`) |
   | `GEMINI_API_KEY` | Chave da API do Google AI Studio |
   | `GOOGLE_CLIENT_ID` | Client ID do OAuth 2.0 no Google Cloud Console |
   | `GOOGLE_CLIENT_SECRET` | Client Secret do OAuth 2.0 |
   | `GOOGLE_REDIRECT_URI` | `https://SEU-PROJETO.railway.app/auth/google/callback` |
   | `FRONTEND_URL` | URL onde o frontend estará hospedado |

5. Para `GOOGLE_REDIRECT_URI`, use:
   ```
   https://SEU-PROJETO.railway.app/auth/google/callback
   ```

6. No **Google Cloud Console**, adicione essa mesma URL em:
   **APIs & Services → Credenciais → OAuth 2.0 → URIs de redirecionamento autorizados**

7. Para `FRONTEND_URL`, use a URL onde o frontend estará hospedado
   (ex: URL do GitHub Pages, Vercel, Netlify, etc.)

8. Aguarde o deploy e copie a URL pública gerada pelo Railway

## Observações

- O arquivo `data/tokens.json` é criado em runtime após o fluxo OAuth. Como o Railway
  usa armazenamento efêmero, os tokens são perdidos a cada redeploy — o usuário precisará
  se reconectar ao Google Calendar após cada deploy.
- O `PORT` é injetado automaticamente pelo Railway; não defina esse valor nas Variables.
- O build roda `tsc` e o start roda `node dist/server.js` — nenhum tsx em produção.

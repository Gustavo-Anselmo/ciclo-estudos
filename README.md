# Ciclo de Estudos

Aplicativo de gestão de estudos com timer de ciclos, integração com Google Calendar e recomendações
geradas por IA. O frontend é uma SPA estática sem dependências de build; o backend expõe uma API REST
que conecta Gemini, Google Calendar e um sistema de notificações agendadas.

## Stack

| Camada | Tecnologias |
|---|---|
| Frontend | HTML, CSS, JavaScript (vanilla) |
| Backend | Node.js, TypeScript, Fastify, Googleapis, Gemini API, node-cron |

## Features

- **Timer de ciclos** — alterna automaticamente entre matérias, com modo Pomodoro configurável
- **Planejamento de provas com IA** — gera blocos de estudo no Google Calendar usando slots livres da agenda
- **Diagnóstico semanal** — analisa progresso por matéria e sugere prioridades via IA
- **Notificações automáticas** — resumo diário às 07:30, lembrete ao fim de cada bloco e alerta de negligência às 20:00
- **Integração Google Calendar** — lê eventos existentes, cria blocos de estudo e calcula horários livres

## Como rodar localmente

### Frontend

Abra `frontend/index.html` diretamente no navegador ou use o Live Server do VS Code.
Nenhuma etapa de build é necessária.

### Backend

```bash
cd backend
cp .env.example .env        # preencha as variáveis no .env
npm install
npm run dev                 # tsx watch — recarrega ao salvar
```

As variáveis obrigatórias no `.env` são:

```
GEMINI_API_KEY=
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REDIRECT_URI=http://localhost:3333/auth/google/callback
FRONTEND_URL=http://localhost:5500
```

Acesse `http://localhost:3333/auth/google` para autorizar o Google Calendar na primeira execução.

## Deploy

- **Backend**: Railway — veja [`backend/README-deploy.md`](backend/README-deploy.md)
- **Frontend**: GitHub Pages — o workflow em `.github/workflows/deploy.yml` publica automaticamente
  a cada push em `main` que altere arquivos em `frontend/`

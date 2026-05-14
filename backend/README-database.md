# Configuração do banco de dados

## Configurar banco no Neon.tech

1. Acessa neon.tech e cria conta gratuita
2. Clica em "New Project" e dá o nome "ciclo-estudos"
3. Seleciona região "US East (N. Virginia)" — mais próxima do Render
4. Após criar, vai em "Connection Details"
5. Copia a "Connection string" no formato:
   ```
   postgresql://user:password@host/dbname?sslmode=require
   ```
6. Essa string é o valor da variável `DATABASE_URL`

## Aplicar o schema

Com o `DATABASE_URL` configurado no `.env` local:

```bash
cd backend
npx prisma db push
```

## Configurar no Render

Adiciona a variável `DATABASE_URL` nas Environment Variables do serviço

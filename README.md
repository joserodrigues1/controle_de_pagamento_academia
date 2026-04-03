# Centro Esportivo CE - SPA Completa

Sistema completo com tema esportivo para:
- Cadastro/login de alunos.
- Envio de pagamento mensal com comprovante.
- PIX copia-e-cola + QR Code com chave `123.456.789-01`.
- Area administrativa com dashboard, usuarios e validacao dos pagamentos.

## Stack

- Frontend: React + Vite + Framer Motion + Recharts
- Backend: Node.js + Express
- Banco: SQLite
- Auth: JWT + bcrypt
- Upload: Multer

## Para que serve a API?

O **backend (Express)** é quem:
- grava login e senhas no SQLite;
- recebe comprovantes (uploads);
- calcula o dashboard do admin;
- gera JWT.

O **React** só é a tela: ele chama rotas em `/api/...`.  
Se você publicar só o front em um host e a API em `localhost`, **não funciona**: o navegador do visitante não alcança o seu PC.

**Solução:** um único processo serve o site (`dist` do Vite) **e** a API na **mesma URL** (mesmo domínio e porta). Já está configurado: após `npm run build`, `npm start` sobe tudo junto.

## Como rodar (desenvolvimento)

```bash
npm install
npm install --prefix server
npm run dev
```

- Interface: `http://localhost:5173` (o Vite encaminha `/api` e `/uploads` para o backend na porta 4000).

## Colocar no ar (produção — um projeto só)

Na pasta do projeto:

```bash
npm install
npm install --prefix server
npm run build
npm start
```

- Um servidor escuta `PORT` (padrão **4000**): site estático + `/api` + `/uploads`.
- Abra `http://localhost:4000` (ou a URL que o provedor der).

**Deploy (Railway, Render, Fly.io, VPS):**  
- **Build:** `npm install && npm install --prefix server && npm run build`  
- **Start:** `npm start`  
- Defina `PORT` se a plataforma exigir (muitas injetam automaticamente).

**Ngrok / Cloudflare Tunnel:** exponha **a mesma porta** onde roda `npm start` (não só o Vite 5173). Ex.: `ngrok http 4000` após `npm run build && npm start`.

**Domínio:** em geral **um** domínio apontando para esse serviço basta; não precisa de dois domínios para front e API quando usam o mesmo processo.

## Fluxo implementado

1. Usuario cria conta e faz login.
2. Usuario envia formulario de pagamento (nome, valor, comprovante).
3. Sistema gera payload PIX e QR Code.
4. Pagamento entra como `pending`.
5. Admin aprova (`paid`) ou rejeita (`rejected`).
6. Dashboard mostra pagantes e faturamento por periodo.

## API open source / mercado para PIX

Para ambiente real (producao), voce pode integrar com:

- **Gerencianet/Efí API PIX**  
  Boa documentacao, gera cobranca, QR Code dinamico e consulta status.
- **Banco Central (DICT/PIX)**  
  Infra oficial, mas integracao direta costuma ser via instituicao participante.
- **Pagar.me** ou **Mercado Pago**  
  APIs maduras para pagamentos, webhooks e conciliacao.
- **Asaas**  
  Simples para cobranca recorrente e confirmacao de pagamento.

### Como validar se pagou

Em producao, use:
- Cobranca com ID unico.
- Webhook do provedor para atualizar status automaticamente.
- Assinatura/secret para validar origem do webhook.

Neste projeto o fluxo de validacao esta pronto no painel admin (aprovacao manual), e pode ser trocado por webhook sem mudar a UI.

## Gerar ZIP no Windows (PowerShell)

Dentro da pasta do projeto:

```powershell
Compress-Archive -Path * -DestinationPath .\centro-esportivo-ce.zip -Force
```
# React + Vite

This template provides a minimal setup to get React working in Vite with HMR and some ESLint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the ESLint configuration

If you are developing a production application, we recommend using TypeScript with type-aware lint rules enabled. Check out the [TS template](https://github.com/vitejs/vite/tree/main/packages/create-vite/template-react-ts) for information on how to integrate TypeScript and [`typescript-eslint`](https://typescript-eslint.io) in your project.
